import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireRunLock, consumeControlRequest, WorkflowJournal, preserveAndTruncateIncompleteTail, readControlRequest, writeAtomicJson } from './journal.js';
import { computePlanHash, createPlan, sha256Text, stableJson, validateWorkflowConfig, WORKFLOW_ADAPTER_VERSIONS } from './plan.js';
import { assertNoSymlinkPath, assertOutputOutsideInput, ensureDirectoryNoLinks, isWithin, pathKey,
  safeRelativePath, sha256File, verifySourceSnapshot } from './paths.js';
import { createReport, getWorkflowStatus, loadRecoveredRun, recoverEvents, type ItemState, type RecoveredRun } from './recovery.js';
import type { ExecuteReceipt, ProbeResult, TrustedWorkflowScript, VerificationEvidence, WorkflowAdapter,
  WorkflowConfig, WorkflowControl, WorkflowItemDecision, WorkflowPlan, WorkflowPlanItem, WorkflowReconcileRequest,
  WorkflowReport, WorkflowRunOptions } from './types.js';

export { getWorkflowStatus };

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hashPattern=/^[a-f0-9]{64}$/i;
const runIdOf=(events:{runId?:unknown}[])=>typeof events[0]?.runId==='string'?events[0].runId:'';

async function assertExecutableMatches(plan:WorkflowPlan):Promise<void> {
  const digest=await sha256File(plan.workflow.executable);
  if (digest!==plan.executableSha256) throw Object.assign(new Error('Configured executable changed since this workflow plan was created'),{code:'executable_changed'});
}

function validateAdapter(adapter:WorkflowAdapter,plan:WorkflowPlan):void {
  if (adapter.id!==plan.workflow.adapter) throw new Error(`Adapter mismatch: plan requires ${plan.workflow.adapter}, got ${adapter.id}`);
  if (adapter.version!==plan.adapterVersion||adapter.version!==WORKFLOW_ADAPTER_VERSIONS[adapter.id])
    throw new Error(`Adapter version mismatch: plan requires ${plan.adapterVersion}, got ${adapter.version}`);
}

function ensureScriptMatches(plan:WorkflowPlan,script:TrustedWorkflowScript|undefined):void {
  if (plan.scriptHash && !script) throw new Error('This run requires its trusted workflow script to resume');
  if (!plan.scriptHash && script) throw new Error('This run was created without a trusted workflow script');
  if (script && (!hashPattern.test(script.hash)||script.hash.toLowerCase()!==plan.scriptHash))
    throw Object.assign(new Error('Trusted workflow script hash changed; create a new run'),{code:'script_changed'});
}

function parseDecision(value:WorkflowItemDecision):WorkflowItemDecision {
  if (!value||!object(value)||!['export','skip'].includes(String(value.decision)))
    throw new Error('Trusted script must return {decision:"export"|"skip", reason?}');
  for (const key of Object.keys(value)) if (!['decision','reason'].includes(key)) throw new Error(`Unknown item decision field: ${key}`);
  if (value.reason!==undefined&&(typeof value.reason!=='string'||value.reason.length>4000)) throw new Error('Item decision reason must be text up to 4000 characters');
  return {decision:value.decision, ...(value.reason?{reason:value.reason}:{})};
}

async function makeRunDirectory(inputRoot:string,runDirectory:string):Promise<string> {
  const run=resolve(runDirectory);
  if (isWithin(inputRoot,run)||isWithin(run,inputRoot)) throw new Error('runDirectory must be separate from inputDirectory');
  await ensureDirectoryNoLinks(dirname(run));
  await assertOutputOutsideInput(inputRoot,run);
  return run;
}

function currentRecovered(plan:WorkflowPlan,runId:string,events:Parameters<typeof recoverEvents>[1]):RecoveredRun {
  // The in-memory writer has only appended complete, fsynced records.
  return recoverEvents(plan,events);
}

async function writeRunFiles(runDirectory:string,plan:WorkflowPlan,runId:string,events:Parameters<typeof recoverEvents>[1],
  journal:WorkflowJournal,kind:string,entry:Record<string,unknown>):Promise<WorkflowReport> {
  const event=await journal.append({kind,...entry});
  events.push(event);
  const recovered=currentRecovered(plan,runId,events);
  const report=createReport(runId,recovered);
  await writeAtomicJson(join(runDirectory,'report.json'),report);
  return report;
}

async function reportProgress(options:WorkflowRunOptions,report:WorkflowReport):Promise<void> {
  try { await options.onProgress?.(report); } catch { /* Reporting cannot alter a persisted action outcome. */ }
}

async function requestAtBoundary(options:WorkflowRunOptions,runDirectory:string):Promise<'pause'|'cancel'|undefined> {
  if (options.signal?.aborted) return 'cancel';
  if (options.control) return options.control.getRequest();
  return readControlRequest(runDirectory);
}

async function assertCandidatePath(runDirectory:string,relativePath:string):Promise<string> {
  const path=await assertNoSymlinkPath(runDirectory,relativePath);
  try {
    const info=await lstat(path);
    if (info.isSymbolicLink()||!info.isFile()) throw new Error(`Candidate is not a regular file: ${path}`);
  } catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  return path;
}

async function quarantineCandidate(runDirectory:string,candidateRelativePath:string,itemId:string):Promise<string|undefined> {
  const candidate=await assertCandidatePath(runDirectory,candidateRelativePath);
  try { await lstat(candidate); } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw error; }
  const failedRoot=join(runDirectory,'failed');await ensureDirectoryNoLinks(failedRoot);
  const target=join(failedRoot,`${itemId}-${randomUUID()}.png`);
  await link(candidate,target);await unlink(candidate);
  return target;
}

async function publishCandidate(runDirectory:string,candidateRelativePath:string,destinationRelativePath:string):Promise<string> {
  const candidate=await assertCandidatePath(runDirectory,candidateRelativePath);
  const artifactRoot=join(runDirectory,'artifacts');await ensureDirectoryNoLinks(artifactRoot);
  const safeDestination=safeRelativePath(destinationRelativePath,'destination path');
  const destination=await assertNoSymlinkPath(artifactRoot,safeDestination);
  await ensureDirectoryNoLinks(dirname(destination));
  await assertNoSymlinkPath(artifactRoot,safeDestination);
  await link(candidate,destination); // Same-volume hard link is atomic and never overwrites.
  return destination;
}

async function markKnownFailure(plan:WorkflowPlan,planItem:WorkflowPlanItem,runDirectory:string,runId:string,
  events:Parameters<typeof recoverEvents>[1],journal:WorkflowJournal,options:WorkflowRunOptions,message:string,
  extra:Record<string,unknown>={},candidateRelativePath?:string):Promise<{report:WorkflowReport;stop:boolean}> {
  if (candidateRelativePath) {
    try { const quarantined=await quarantineCandidate(runDirectory,candidateRelativePath,planItem.id);
      if (quarantined) extra.quarantinedPath=quarantined; } catch(error) { extra.quarantineError=String(error); }
  }
  const report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_failure',
    {itemId:planItem.id,message,...extra});
  if (plan.workflow.onError==='stop') {
    const failed=await writeRunFiles(runDirectory,plan,runId,events,journal,'run_failed',
      {message:`${planItem.source.relativePath}: ${message}`});
    return {report:failed,stop:true};
  }
  await reportProgress(options,report);
  return {report,stop:false};
}

async function runItems(plan:WorkflowPlan,adapter:WorkflowAdapter,runDirectory:string,runId:string,journal:WorkflowJournal,
  events:Parameters<typeof recoverEvents>[1],options:WorkflowRunOptions):Promise<WorkflowReport> {
  const inputRoot=plan.workflow.inputDirectory;
  const artifactRoot=join(runDirectory,'artifacts');
  const stagingRoot=join(runDirectory,'.staging');
  await ensureDirectoryNoLinks(artifactRoot);await ensureDirectoryNoLinks(stagingRoot);
  let report=createReport(runId,currentRecovered(plan,runId,events));
  for (const planItem of plan.items) {
    let recovered=currentRecovered(plan,runId,events);
    let state=recovered.items.get(planItem.id)!;
    if (state.status==='completed'||state.status==='skipped'||state.status==='unsupported') continue;
    if (state.status==='needs_reconciliation'||state.status==='conflict') return recoveredReport(runId,recovered);
    if (state.status==='failed'&&plan.workflow.onError==='stop') return recoveredReport(runId,recovered);
    if (state.status==='failed') continue; // Known failed items are reported, never silently retried on resume.
    const request=await requestAtBoundary(options,runDirectory);
    if (request==='pause') {
      report=await writeRunFiles(runDirectory,plan,runId,events,journal,'run_paused',{message:'Paused at an item boundary'});
      await reportProgress(options,report);return report;
    }
    if (request==='cancel') {
      report=await writeRunFiles(runDirectory,plan,runId,events,journal,'run_cancelled',{message:'Cancelled at an item boundary'});
      await reportProgress(options,report);return report;
    }
    const candidateRel=`.staging/${planItem.id}-${randomUUID()}.png`;
    let probe:ProbeResult;
    try {
      await verifySourceSnapshot(planItem.source,inputRoot);
      probe=await adapter.probe(planItem.source);
      if (!probe||!['supported','unsupported','failed'].includes(probe.status)) throw new Error('Adapter returned an invalid probe result');
      if (probe.status==='supported'&&!object(probe.expected)) throw new Error('Adapter probe expected value must be an object');
      stableJson(probe);
    } catch(error) {
      report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_probe',
        {itemId:planItem.id,result:{status:'failed',code:'probe_failed',message:error instanceof Error?error.message:String(error)}});
      const failure=await markKnownFailure(plan,planItem,runDirectory,runId,events,journal,options,
        error instanceof Error?error.message:String(error),{phase:'probe'});
      if(failure.stop)return failure.report;report=failure.report;continue;
    }
    report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_probe',{itemId:planItem.id,result:probe});
    await reportProgress(options,report);
    if (probe.status==='unsupported') {
      await reportProgress(options,report);continue;
    }
    if (probe.status==='failed') {
      const failure=await markKnownFailure(plan,planItem,runDirectory,runId,events,journal,options,probe.message,{phase:'probe',code:probe.code});
      report=failure.report;if(failure.stop)return report;continue;
    }
    state=currentRecovered(plan,runId,events).items.get(planItem.id)!;
    let decision:WorkflowItemDecision;
    if (state.decision) {
      if (state.decisionExpected&&stableJson(state.decisionExpected)!==stableJson(probe.expected)) {
        report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_conflict',
          {itemId:planItem.id,message:'Adapter expectations changed since this item decision was recorded'});
        report=await writeRunFiles(runDirectory,plan,runId,events,journal,'run_needs_reconciliation',
          {message:`${planItem.source.relativePath}: adapter expectations changed`});
        return report;
      }
      decision={decision:state.decision,reason:state.message};
    } else {
      try { decision=parseDecision(options.trustedScript?await options.trustedScript.decideItem(planItem.source,probe):{decision:'export'}); }
      catch(error) {
        report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_decision_error',
          {itemId:planItem.id,message:error instanceof Error?error.message:String(error)});
        const failed=await writeRunFiles(runDirectory,plan,runId,events,journal,'run_failed',
          {message:`Trusted item decision failed for ${planItem.source.relativePath}`});
        await reportProgress(options,failed);return failed;
      }
      report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_decision',
        {itemId:planItem.id,decision:decision.decision,reason:decision.reason??'',expected:probe.expected});
      await reportProgress(options,report);
      if (decision.decision==='skip') continue;
    }
    try { await verifySourceSnapshot(planItem.source,inputRoot); }
    catch(error) {
      report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_conflict',
        {itemId:planItem.id,message:error instanceof Error?error.message:String(error)});
      if(plan.workflow.onError==='stop') return await writeRunFiles(runDirectory,plan,runId,events,journal,'run_failed',{message:'Frozen input changed before dispatch'});
      continue;
    }
    const destinationRelative=planItem.destinationRelativePath;
    let destination:string;
    try {
      destination=await assertNoSymlinkPath(artifactRoot,destinationRelative);
      await ensureDirectoryNoLinks(dirname(destination));
      await assertNoSymlinkPath(artifactRoot,destinationRelative);
      await lstat(destination);
      report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_conflict',
        {itemId:planItem.id,message:`Output already exists: ${destinationRelative}`});
      if(plan.workflow.onError==='stop') return await writeRunFiles(runDirectory,plan,runId,events,journal,'run_failed',{message:`Output conflict: ${destinationRelative}`});
      continue;
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code!=='ENOENT') {
        if (String(error).includes('Output already exists')) throw error;
        const failure=await markKnownFailure(plan,planItem,runDirectory,runId,events,journal,options,String(error),{phase:'output_preflight'});
        if(failure.stop)return failure.report;report=failure.report;continue;
      }
      destination=resolve(artifactRoot,destinationRelative);
    }
    const candidatePath=resolve(runDirectory,candidateRel);
    try {
      await assertNoSymlinkPath(runDirectory,candidateRel);
      await writeRunFiles(runDirectory,plan,runId,events,journal,'item_intent',{itemId:planItem.id,
        sourceSha256:planItem.source.sha256,destinationRelativePath:destinationRelative,
        candidateRelativePath:candidateRel,expected:probe.expected,decision:decision.decision});
      const timer=AbortSignal.timeout(plan.workflow.timeoutMs??120_000);
      const executionSignal=options.signal?AbortSignal.any([options.signal,timer]):timer;
      let receipt:ExecuteReceipt;
      try { receipt=await adapter.execute(planItem.source.absolutePath,candidatePath,executionSignal); }
      catch(error) { receipt={status:'unknown',dispatch:'possibly_partial',code:'adapter_exception',message:error instanceof Error?error.message:String(error)}; }
      if (!receipt||!['completed','failed','unknown'].includes(receipt.status))
        receipt={status:'unknown',dispatch:'possibly_partial',code:'invalid_receipt',message:'Adapter returned an invalid execution receipt'};
      stableJson(receipt);
      report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_receipt',{itemId:planItem.id,receipt});
      if(receipt.status==='unknown') {
        report=await writeRunFiles(runDirectory,plan,runId,events,journal,'run_needs_reconciliation',
          {message:`${planItem.source.relativePath}: ${receipt.message}`});
        await reportProgress(options,report);return report;
      }
      if(receipt.status==='failed') {
        const failure=await markKnownFailure(plan,planItem,runDirectory,runId,events,journal,options,receipt.message,
          {phase:'execute',code:receipt.code,dispatch:receipt.dispatch},candidateRel);
        if(failure.stop)return failure.report;report=failure.report;continue;
      }
      let evidence:VerificationEvidence;
      try { evidence=await adapter.verify(candidatePath,probe.expected); }
      catch(error) { evidence={status:'failed',verifier:'adapter-verifier',expected:probe.expected,message:error instanceof Error?error.message:String(error)}; }
      if(!evidence||!['verified','failed'].includes(evidence.status)||!object(evidence.expected))
        evidence={status:'failed',verifier:'adapter-verifier',expected:probe.expected,message:'Adapter returned invalid verification evidence'};
      stableJson(evidence);
      if(evidence.status!=='verified') {
        const failure=await markKnownFailure(plan,planItem,runDirectory,runId,events,journal,options,
          evidence.message??'Artifact verification failed',{phase:'verification',evidence},candidateRel);
        if(failure.stop)return failure.report;report=failure.report;continue;
      }
      try { await verifySourceSnapshot(planItem.source,inputRoot); }
      catch(error) {
        await writeRunFiles(runDirectory,plan,runId,events,journal,'item_conflict',
          {itemId:planItem.id,message:`Source changed during export: ${error instanceof Error?error.message:String(error)}`,evidence,candidateRelativePath:candidateRel});
        return await writeRunFiles(runDirectory,plan,runId,events,journal,'run_needs_reconciliation',
          {message:`${planItem.source.relativePath}: source changed while exporting`});
      }
      try { await publishCandidate(runDirectory,candidateRel,destinationRelative); }
      catch(error) {
        if((error as NodeJS.ErrnoException).code==='EEXIST') {
          await writeRunFiles(runDirectory,plan,runId,events,journal,'item_conflict',
            {itemId:planItem.id,message:`Output appeared during export: ${destinationRelative}`,evidence,candidateRelativePath:candidateRel});
          return await writeRunFiles(runDirectory,plan,runId,events,journal,'run_needs_reconciliation',
            {message:`Output conflict during export: ${destinationRelative}`});
        }
        throw error;
      }
      const artifactSha256=await sha256File(destination);
      report=await writeRunFiles(runDirectory,plan,runId,events,journal,'item_commit',
        {itemId:planItem.id,artifactSha256,evidence});
      // Keep the intent candidate through the durable commit boundary so recovery can prove
      // a final-only file came from this intent if the process exits before cleanup.
      try { await unlink(candidatePath); } catch { /* The committed artifact remains authoritative. */ }
      await reportProgress(options,report);
    } catch(error) {
      // Failures after the intent is durable are uncertain unless an explicit receipt already exists.
      const latest=currentRecovered(plan,runId,events).items.get(planItem.id)!;
      if(latest.hasIntent&&latest.status!=='completed'&&latest.status!=='failed'&&latest.status!=='needs_reconciliation') {
        const message=error instanceof Error?error.message:String(error);
        if(!latest.receipt) {
          const unknown:ExecuteReceipt={status:'unknown',dispatch:'possibly_partial',code:'runtime_exception',message};
          await writeRunFiles(runDirectory,plan,runId,events,journal,'item_receipt',{itemId:planItem.id,receipt:unknown});
        }
        report=await writeRunFiles(runDirectory,plan,runId,events,journal,'run_needs_reconciliation',{message});
        return report;
      }
      throw error;
    }
  }
  const finalState=currentRecovered(plan,runId,events);
  if(finalState.status==='needs_reconciliation') return recoveredReport(runId,finalState);
  const hasIssues=[...finalState.items.values()].some(item=>['failed','unsupported','conflict'].includes(item.status));
  report=await writeRunFiles(runDirectory,plan,runId,events,journal,'run_completed',
    {status:hasIssues?'completed_with_errors':'completed'});
  await reportProgress(options,report);return report;
}

function recoveredReport(runId:string,recovered:RecoveredRun):WorkflowReport { return createReport(runId,recovered); }

async function executeNewRun(plan:WorkflowPlan,adapter:WorkflowAdapter,runDirectory:string,
  options:WorkflowRunOptions):Promise<WorkflowReport> {
  const runId=randomUUID();
  const release=await acquireRunLock(runDirectory);
  let journal:WorkflowJournal|undefined;
  try {
    validateAdapter(adapter,plan);ensureScriptMatches(plan,options.trustedScript);
    await assertExecutableMatches(plan);
    await mkdir(join(runDirectory,'artifacts'),{recursive:false});
    await mkdir(join(runDirectory,'.staging'),{recursive:false});
    await writeAtomicJson(join(runDirectory,'plan.json'),plan);
    journal=await WorkflowJournal.create(runDirectory);
    const events=[] as Awaited<ReturnType<typeof import('./journal.js').readWorkflowEvents>>;
    events.push(await journal.append({kind:'run_started',runId,planHash:plan.planHash,
      executableSha256:plan.executableSha256,adapterVersion:plan.adapterVersion,scriptHash:plan.scriptHash??null}));
    await writeAtomicJson(join(runDirectory,'report.json'),createReport(runId,currentRecovered(plan,runId,events)));
    return await runItems(plan,adapter,runDirectory,runId,journal,events,options);
  } finally { await journal?.close();await release(); }
}

export async function startWorkflow(config:WorkflowConfig,adapter:WorkflowAdapter,runDirectory:string,
  options:WorkflowRunOptions={}):Promise<WorkflowReport> {
  const plan=await createPlan(config,{...(options.trustedScript?{scriptHash:options.trustedScript.hash}:{})});
  validateAdapter(adapter,plan);ensureScriptMatches(plan,options.trustedScript);
  const run=await makeRunDirectory(plan.workflow.inputDirectory,runDirectory);
  try { await mkdir(run,{recursive:false}); }
  catch(error) { if((error as NodeJS.ErrnoException).code==='EEXIST') throw new Error(`runDirectory already exists: ${run}`);throw error; }
  try { return await executeNewRun(plan,adapter,run,options); }
  catch(error) {
    // Keep the run directory and its plan/journal for inspection after setup or execution failures.
    throw error;
  }
}

async function verifyCompletedItems(runDirectory:string,recovered:RecoveredRun,journal:WorkflowJournal,
  events:Parameters<typeof recoverEvents>[1]):Promise<WorkflowReport|undefined> {
  for(const planItem of recovered.plan.items) {
    const state=recovered.items.get(planItem.id)!;
    if(state.status!=='completed')continue;
    try {
      await verifySourceSnapshot(planItem.source,recovered.plan.workflow.inputDirectory);
      const artifact=await assertNoSymlinkPath(join(runDirectory,'artifacts'),planItem.destinationRelativePath,false);
      const info=await lstat(artifact);
      if(info.isSymbolicLink()||!info.isFile()) throw new Error('Completed artifact is not a regular file');
      if(await sha256File(artifact)!==state.artifactSha256) throw new Error('Completed artifact SHA-256 changed');
    } catch(error) {
      const report=await writeRunFiles(runDirectory,recovered.plan,recovered.runId,events,journal,
        'item_integrity_conflict',{itemId:planItem.id,message:error instanceof Error?error.message:String(error)});
      return await writeRunFiles(runDirectory,recovered.plan,recovered.runId,events,journal,'run_needs_reconciliation',
        {message:`${planItem.source.relativePath}: completed item integrity changed`});
    }
  }
  return undefined;
}

export async function resumeWorkflow(adapter:WorkflowAdapter,runDirectory:string,options:WorkflowRunOptions={}):Promise<WorkflowReport> {
  const run=resolve(runDirectory);
  const rootInfo=await lstat(run);
  if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error('runDirectory must be a real directory');
  const release=await acquireRunLock(run);
  let journal:WorkflowJournal|undefined;
  try {
    const recovered=await loadRecoveredRun(run);
    validateAdapter(adapter,recovered.plan);ensureScriptMatches(recovered.plan,options.trustedScript);
    await assertExecutableMatches(recovered.plan);
    if(recovered.status==='needs_reconciliation')throw new Error(recovered.message??'Workflow needs reconciliation before resume');
    if(recovered.status==='cancelled')throw new Error('Cancelled workflow is terminal; create a new run');
    if(recovered.status==='completed'||recovered.status==='completed_with_errors') {
      // A completed run is still checked against the frozen source/artifact digests before reuse.
    } else if(!['paused','failed','running'].includes(recovered.status)) throw new Error(`Workflow cannot resume from status ${recovered.status}`);
    const events=recovered.events;
    journal=await WorkflowJournal.appendExisting(run);
    if(recovered.status==='paused') await consumeControlRequest(run);
    const integrity=await verifyCompletedItems(run,recovered,journal,events);
    if(integrity)return integrity;
    if(recovered.status==='completed'||recovered.status==='completed_with_errors')return recoveredReport(recovered.runId,recovered);
    if(recovered.plan.workflow.onError==='stop'&&recovered.plan.items.some(item=>recovered.items.get(item.id)?.status==='failed'||recovered.items.get(item.id)?.status==='conflict'))
      throw new Error('A failed/conflicting item must be reconciled or skipped before resume');
    await writeRunFiles(run,recovered.plan,recovered.runId,events,journal,'run_resumed',{from:'next-unfinished-item'});
    return await runItems(recovered.plan,adapter,run,recovered.runId,journal,events,options);
  } finally { await journal?.close();await release(); }
}

export async function reconcileWorkflow(runDirectory:string,itemId:string,request:WorkflowReconcileRequest,
  adapter:WorkflowAdapter):Promise<WorkflowReport> {
  if(!request.reason?.trim())throw new Error('Reconciliation requires a nonempty reason');
  if(request.action!=='accept'&&request.action!=='skip')throw new Error('Reconciliation action must be accept or skip');
  if(request.action==='skip'&&request.acknowledged!==true)throw new Error('Skipping an uncertain item requires explicit acknowledged:true');
  const run=resolve(runDirectory);const release=await acquireRunLock(run);let journal:WorkflowJournal|undefined;
  try {
    // Inspect the complete prefix before changing a damaged journal. An invalid
    // item id or an already completed item must leave the original bytes intact.
    const inspected=await loadRecoveredRun(run,{allowIncompleteTail:true});
    validateAdapter(adapter,inspected.plan);
    const inspectedItem=inspected.plan.items.find(item=>item.id===itemId);
    if(!inspectedItem)throw new Error(`Unknown workflow item: ${itemId}`);
    const inspectedState=inspected.items.get(itemId)!;
    if(!['needs_reconciliation','failed','conflict','unsupported','skipped'].includes(inspectedState.status))
      throw new Error(`Item cannot be reconciled from ${inspectedState.status}`);
    if(request.action==='accept'&&(!inspectedState.hasIntent||!inspectedState.probeExpected))
      throw new Error('Cannot accept an output without a durable export intent and expected artifact contract');
    if(inspected.incompleteTail) await preserveAndTruncateIncompleteTail(run);
    const recovered=inspected.incompleteTail?await loadRecoveredRun(run):inspected;
    validateAdapter(adapter,recovered.plan);
    const planItem=recovered.plan.items.find(item=>item.id===itemId);
    if(!planItem)throw new Error(`Unknown workflow item: ${itemId}`);
    const state=recovered.items.get(itemId)!;
    if(!['needs_reconciliation','failed','conflict','unsupported','skipped'].includes(state.status))
      throw new Error(`Item cannot be reconciled from ${state.status}`);
    const events=recovered.events;
    journal=await WorkflowJournal.appendExisting(run);
    if(request.action==='skip') {
      const report=await writeRunFiles(run,recovered.plan,recovered.runId,events,journal,'item_reconcile',
        {itemId,action:'skip',reason:request.reason,acknowledged:true});
      return report;
    }
    if(!state.hasIntent||!state.probeExpected)throw new Error('Cannot accept an output without a durable export intent and expected artifact contract');
    await verifySourceSnapshot(planItem.source,recovered.plan.workflow.inputDirectory);
    const intent=[...events].reverse().find(event=>event.kind==='item_intent'&&event.itemId===itemId);
    const candidateRelativePath=String(intent?.candidateRelativePath??'');
    const finalPath=await assertNoSymlinkPath(join(run,'artifacts'),planItem.destinationRelativePath,false).catch(()=>undefined);
    const candidatePath=candidateRelativePath?await assertNoSymlinkPath(run,candidateRelativePath,false).catch(()=>undefined):undefined;
    const committedBaseline=state.status==='conflict'?state.artifactSha256:undefined;
    let inspectPath:string|undefined;
    if(committedBaseline&&finalPath) inspectPath=finalPath;
    else if(candidatePath) inspectPath=candidatePath;
    if(!inspectPath)throw new Error('No candidate or final artifact exists to verify');
    const evidence=await adapter.verify(inspectPath,state.probeExpected);
    if(evidence.status!=='verified')throw new Error(evidence.message??'Artifact did not pass the adapter verifier');
    const verifiedCandidateHash=await sha256File(inspectPath);
    if(committedBaseline&&verifiedCandidateHash!==committedBaseline)
      throw new Error('Previously committed artifact must match its original SHA-256 before it can be accepted');
    if(inspectPath===candidatePath) {
      if(finalPath) {
        const existingHash=await sha256File(finalPath);
        if(existingHash!==verifiedCandidateHash)throw new Error('Existing final artifact does not match this intent candidate');
      } else {
        await publishCandidate(run,candidateRelativePath,planItem.destinationRelativePath);
      }
      inspectPath=await assertNoSymlinkPath(join(run,'artifacts'),planItem.destinationRelativePath,false);
    }
    await verifySourceSnapshot(planItem.source,recovered.plan.workflow.inputDirectory);
    const committedHash=await sha256File(inspectPath);
    if(committedHash!==verifiedCandidateHash)throw new Error('Final artifact changed during reconciliation');
    const report=await writeRunFiles(run,recovered.plan,recovered.runId,events,journal,'item_reconcile',
      {itemId,action:'accept',reason:request.reason,artifactSha256:committedHash,evidence});
    if(candidateRelativePath)try{await unlink(resolve(run,candidateRelativePath));}catch{/* final artifact remains committed */}
    return report;
  } finally { await journal?.close();await release(); }
}

export function controlFileWorkflowControl(runDirectory:string):WorkflowControl {
  return { getRequest:()=>readControlRequest(runDirectory) };
}
