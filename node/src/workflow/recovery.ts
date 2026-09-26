import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkflowEvent } from './journal.js';
import { isRunLockActive, writeAtomicJson } from './journal.js';
import type { WorkflowCounts, WorkflowItemStatus, WorkflowPlan, WorkflowReport, WorkflowReportItem, WorkflowRunStatus } from './types.js';
import { computePlanHash } from './plan.js';

export type ItemState = {
  status: WorkflowItemStatus;
  decision?: 'export'|'skip';
  probeExpected?: Record<string,unknown>;
  decisionExpected?: Record<string,unknown>;
  receipt?: Record<string,unknown>;
  evidence?: Record<string,unknown>;
  artifactSha256?:string;
  message?:string;
  hasIntent:boolean;
};
export type RecoveredRun = { runId:string; plan:WorkflowPlan; events:WorkflowEvent[]; items:Map<string,ItemState>;
  status:WorkflowRunStatus; incompleteTail?:boolean; updatedAt:string; message?:string };
const obj=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const terminal=(status:WorkflowItemStatus)=>['completed','failed','skipped','unsupported','conflict'].includes(status);

export function initialItemState():ItemState { return {status:'not_started',hasIntent:false}; }

export function recoverEvents(plan:WorkflowPlan,events:WorkflowEvent[],incompleteTail=false,allowLiveInFlight=false):RecoveredRun {
  if (!events.length || events[0].kind!=='run_started' || events[0].planHash!==plan.planHash)
    throw new Error('Workflow journal does not match its frozen plan');
  if (typeof events[0].runId!=='string'||!events[0].runId) throw new Error('Workflow journal has no run id');
  const ids=new Set(plan.items.map(item=>item.id));
  const items=new Map<string,ItemState>(plan.items.map(item=>[item.id,initialItemState()]));
  let status:WorkflowRunStatus='running',updatedAt=events[0].time,message:string|undefined;
  let activeItem='';
  for (const event of events.slice(1)) {
    updatedAt=event.time;
    const kind=event.kind;
    if (kind==='run_resumed') { if (!['paused','failed','running'].includes(status)) throw new Error('Invalid run resume transition'); status='running';message=undefined;continue; }
    if (kind==='run_paused') { status='paused';message=String(event.message??'Paused at item boundary');continue; }
    if (kind==='run_cancelled') { status='cancelled';message=String(event.message??'Cancelled at item boundary');continue; }
    if (kind==='run_needs_reconciliation') { status='needs_reconciliation';message=String(event.message??'Action outcome needs reconciliation');continue; }
    if (kind==='run_failed') { status='failed';message=String(event.message??'Workflow stopped after a known failure');continue; }
    if (kind==='run_completed') {
      const requested=event.status;
      if (requested!=='completed'&&requested!=='completed_with_errors') throw new Error('Invalid completed run status');
      if ([...items.values()].some(item=>item.status==='not_started'||item.status==='needs_reconciliation'))
        throw new Error('Run completed with unfinished items');
      const hasIssues=[...items.values()].some(item=>['failed','unsupported','conflict'].includes(item.status));
      if ((requested==='completed_with_errors')!==hasIssues) throw new Error('Run completion status does not match item outcomes');
      status=requested;message=undefined;continue;
    }
    if (kind==='item_decision_error') { activeItem=String(event.itemId??'');if(!ids.has(activeItem))throw new Error('Journal refers to an unknown item');items.get(activeItem)!.message=String(event.message??'Script decision failed');continue; }
    const itemId=String(event.itemId??'');
    if (!ids.has(itemId)) throw new Error(`Journal refers to unknown item: ${itemId}`);
    const state=items.get(itemId)!;
    const index=plan.items.findIndex(item=>item.id===itemId);
    for (const preceding of plan.items.slice(0,index)) {
      const previous=items.get(preceding.id)!;
      if (!terminal(previous.status) && previous.status!=='needs_reconciliation')
        throw new Error(`Journal item order skipped ${preceding.id}`);
      if (previous.status==='needs_reconciliation') throw new Error(`Journal advanced while ${preceding.id} needed reconciliation`);
      if (previous.status==='failed' && plan.workflow.onError==='stop')
        throw new Error(`Journal advanced past failed item ${preceding.id} under onError=stop`);
    }
    if (kind==='item_probe') {
      if (state.hasIntent || state.status==='completed'||state.status==='skipped'||state.status==='unsupported')
        throw new Error(`Probe occurred after item processing began: ${itemId}`);
      const probe=obj(event.result);
      if (!['supported','unsupported','failed'].includes(String(probe.status))) throw new Error(`Invalid probe result for ${itemId}`);
      state.probeExpected=probe.status==='supported'?obj(probe.expected):undefined;
      state.message=String(probe.message??'')||undefined;
      if (probe.status==='unsupported') { state.status='unsupported';state.message=String(probe.message??'Unsupported input'); }
      else if (probe.status==='failed') { state.status='failed';state.message=String(probe.message??'Input probe failed'); }
    } else if (kind==='item_decision') {
      if (!state.probeExpected || state.decision || state.hasIntent) throw new Error(`Invalid item decision: ${itemId}`);
      if (event.decision!=='export'&&event.decision!=='skip') throw new Error(`Invalid item decision value: ${itemId}`);
      state.decision=event.decision;state.message=typeof event.reason==='string'?event.reason:undefined;
      state.decisionExpected=obj(event.expected);
      if (event.decision==='skip') state.status='skipped';
    } else if (kind==='item_intent') {
      if (state.decision!=='export'||!state.probeExpected||state.hasIntent||state.status!=='not_started')
        throw new Error(`Invalid action intent: ${itemId}`);
      state.hasIntent=true;activeItem=itemId;
    } else if (kind==='item_receipt') {
      if (!state.hasIntent||state.receipt) throw new Error(`Unexpected item receipt: ${itemId}`);
      const receipt=obj(event.receipt);state.receipt=receipt;
      if (receipt.status==='unknown') { state.status='needs_reconciliation';state.message=String(receipt.message??'Action outcome is unknown');status='needs_reconciliation';message=state.message; }
      else if (receipt.status==='failed') { state.status='failed';state.message=String(receipt.message??'Action failed'); }
      else if (receipt.status!=='completed') throw new Error(`Invalid adapter receipt: ${itemId}`);
    } else if (kind==='item_commit') {
      if (!state.hasIntent||state.receipt?.status!=='completed'||state.status==='completed') throw new Error(`Commit without completed receipt or duplicate commit: ${itemId}`);
      const evidence=obj(event.evidence);
      if (evidence.status!=='verified') throw new Error(`Commit without successful verification: ${itemId}`);
      state.status='completed';state.evidence=evidence;state.artifactSha256=String(event.artifactSha256??'');state.message=undefined;
    } else if (kind==='item_failure') {
      if (state.status==='completed'||state.status==='skipped'||state.status==='unsupported'||state.status==='needs_reconciliation')
        throw new Error(`Failure event after terminal/uncertain state: ${itemId}`);
      state.status='failed';state.message=String(event.message??'Item failed');
    } else if (kind==='item_conflict') {
      if (state.status==='completed'||state.status==='skipped') throw new Error(`Invalid output conflict event: ${itemId}`);
      state.status='conflict';state.message=String(event.message??'Output path conflict');
    } else if (kind==='item_integrity_conflict') {
      if (state.status!=='completed') throw new Error(`Integrity conflict requires a completed item: ${itemId}`);
      state.status='conflict';state.message=String(event.message??'Completed item evidence changed');
      status='needs_reconciliation';message=state.message;
    } else if (kind==='item_reconcile') {
      const abandonedIntent=state.hasIntent&&!state.receipt&&state.status==='not_started';
      if (!abandonedIntent&&!['needs_reconciliation','failed','conflict','unsupported','skipped'].includes(state.status))
        throw new Error(`Item cannot be reconciled from ${state.status}: ${itemId}`);
      if (event.action==='accept') {
        const evidence=obj(event.evidence);
        if (!state.hasIntent||!state.probeExpected||evidence.status!=='verified'||typeof event.artifactSha256!=='string'||!event.artifactSha256)
          throw new Error(`Accepted reconciliation lacks verified evidence: ${itemId}`);
        state.status='completed';state.evidence=evidence;state.artifactSha256=event.artifactSha256;state.message=undefined;
      } else if (event.action==='skip') {
        if (typeof event.reason!=='string'||!event.reason.trim()||event.acknowledged!==true)
          throw new Error(`Reconciled skip requires an acknowledged reason: ${itemId}`);
        state.status='skipped';state.message=event.reason;
      } else throw new Error(`Invalid reconciliation action: ${itemId}`);
      if (status==='needs_reconciliation'||status==='failed'||status==='completed'||status==='completed_with_errors') {
        status='paused';message='Item reconciled; resume is available';
      }
    } else throw new Error(`Unknown workflow journal event: ${kind}`);
  }
  for (const [id,state] of items) {
    if (state.hasIntent && state.status!=='completed' && state.status!=='failed' && state.status!=='needs_reconciliation' && state.status!=='skipped') {
      state.status=allowLiveInFlight?'in_progress':'needs_reconciliation';
      state.message=allowLiveInFlight?'Action is currently in progress':'A durable action intent has no verified commit';
      status=allowLiveInFlight?'running':'needs_reconciliation';message=state.message;
    }
  }
  if (incompleteTail) {
    if (allowLiveInFlight) { status='running';message='Workflow is writing its latest journal event'; }
    else { status='needs_reconciliation';message='Journal has an incomplete final event'; }
  }
  if ([...items.values()].some(item=>item.status==='needs_reconciliation')) {
    status='needs_reconciliation';
    const pending=plan.items.find(item=>items.get(item.id)?.status==='needs_reconciliation');
    message=items.get(pending!.id)?.message??'An item needs reconciliation';
  }
  return {runId:String(events[0].runId),plan,events,items,status,incompleteTail,updatedAt,message};
}

export async function loadRecoveredRun(runDirectory:string, options:{allowIncompleteTail?:boolean;allowLiveInFlight?:boolean}={}):Promise<RecoveredRun> {
  const root=resolve(runDirectory);
  const plan=JSON.parse(await readFile(join(root,'plan.json'),'utf8')) as WorkflowPlan;
  if (!plan || plan.schemaVersion!==1 || typeof plan.planHash!=='string' || computePlanHash(plan)!==plan.planHash)
    throw new Error('Frozen workflow plan hash is invalid');
  const source=await readFile(join(root,'execution.jsonl'),'utf8');
  const incompleteTail=!source.endsWith('\n');
  if (incompleteTail&&!options.allowIncompleteTail) throw new Error('Workflow journal ends with an incomplete event');
  const lines=source.split(/\r?\n/);
  if (incompleteTail) lines.pop();
  const events:WorkflowEvent[]=[];
  for (const [index,line] of lines.filter(Boolean).entries()) {
    let value:unknown;try {value=JSON.parse(line);} catch {throw new Error(`Workflow journal event ${index+1} is invalid JSON`);}
    if (!value||typeof value!=='object'||Array.isArray(value)) throw new Error(`Workflow event ${index+1} is not an object`);
    const event=value as WorkflowEvent;
    if (event.seq!==index+1||typeof event.kind!=='string'||typeof event.time!=='string') throw new Error(`Workflow journal sequence is invalid at ${index+1}`);
    events.push(event);
  }
  return recoverEvents(plan,events,incompleteTail,options.allowLiveInFlight===true);
}

export function createReport(runId:string,recovered:RecoveredRun):WorkflowReport {
  const counts:WorkflowCounts={total:recovered.plan.items.length,not_started:0,in_progress:0,completed:0,failed:0,skipped:0,
    unsupported:0,conflict:0,needs_reconciliation:0};
  const items:WorkflowReportItem[]=recovered.plan.items.map(planItem=>{
    const state=recovered.items.get(planItem.id)!;counts[state.status]++;
    return {itemId:planItem.id,sourceRelativePath:planItem.source.relativePath,
      destinationRelativePath:planItem.destinationRelativePath,status:state.status,
      sourceSha256:planItem.source.sha256,...(state.artifactSha256?{artifactSha256:state.artifactSha256}:{}),
      ...(state.probeExpected?{expected:state.probeExpected}:{}),
      ...(state.evidence?{evidence:state.evidence as WorkflowReportItem['evidence']}:{}),
      ...(state.message?{message:state.message}:{})};
  });
  return {schemaVersion:1,runId,name:recovered.plan.workflow.name,status:recovered.status,planHash:recovered.plan.planHash,
    createdAt:recovered.events[0]?.time??recovered.plan.createdAt,updatedAt:recovered.updatedAt,counts,items,
    ...(recovered.message?{message:recovered.message}:{})};
}

export async function persistReport(runDirectory:string,runId:string,recovered:RecoveredRun):Promise<WorkflowReport> {
  const report=createReport(runId,recovered);
  await writeAtomicJson(join(resolve(runDirectory),'report.json'),report);
  return report;
}

export async function getWorkflowStatus(runDirectory:string):Promise<WorkflowReport> {
  const live=await isRunLockActive(runDirectory);
  const recovered=await loadRecoveredRun(runDirectory,{allowIncompleteTail:true,allowLiveInFlight:live});
  const report=createReport(recovered.runId,recovered);
  // Never use a stale report.json to conceal a damaged/incomplete journal.
  return report;
}
