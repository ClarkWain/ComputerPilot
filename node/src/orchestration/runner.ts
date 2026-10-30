import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRunLock, consumeControlRequest, isRunLockActive, readControlRequest, readWorkflowEvents,
  preserveAndTruncateIncompleteTail, WorkflowJournal, writeAtomicJson,
  type WorkflowEvent } from '../workflow/journal.js';
import { assertExistingDirectoryNoLinks, ensureDirectoryNoLinks, sha256File } from '../workflow/paths.js';
import { sha256Text, stableJson } from '../workflow/plan.js';
import { validateCondition } from '../replay/recipe.js';
import { ORCHESTRATION_WORKER_MARKER } from './script-worker.js';
import { validateDesktopReconciliation } from './result.js';
import { CommandNotDispatchedError } from './types.js';
import type { AskArgs, CommandKind, CommandRequest, OrchestrationDefinition, OrchestrationHost,
  OrchestrationReport, OrchestrationStatus } from './types.js';

const maxCommands = 10_000;
const maxRunMs = 30 * 60_000;
const keys = new Set<CommandKind>(['readInput','observe','step','waitFor','ask','checkpoint','suno']);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const commandKey = (request: CommandRequest): string => `${request.scope}/${request.id}`;
const normalized = (request: CommandRequest): CommandRequest =>
  ({ kind: request.kind, scope: request.scope, id: request.id, args: request.args ?? null });

type History = { committed: Array<{ request: CommandRequest; value: unknown }>;
  pending?: { request: CommandRequest; message?: string; dispatch?: 'not_dispatched' };
  retry?: CommandRequest; finished: boolean; result?: unknown; failed?: string;
  readRetries: Map<string,number>; paused: boolean; cancelled: boolean };

function safelyRetryable(request: CommandRequest): boolean {
  return ['readInput','observe','checkpoint'].includes(request.kind) ||
    (request.kind === 'suno' && object(request.args) &&
      ['inspect','prepare','wait'].includes(String(request.args.op)));
}

function inspectEvents(definition: OrchestrationDefinition, events: WorkflowEvent[]): History {
  if (!events.length || events[0].kind !== 'run_started' || events[0].scriptSha256 !== definition.scriptSha256 ||
      events[0].inputSha256 !== definition.inputSha256) throw new Error('Orchestration journal does not match its definition');
  const committed: History['committed'] = [];
  const seen = new Set<string>();
  const readRetries = new Map<string,number>();
  let pending: History['pending'];
  let retry: History['retry'];
  let finished = false;
  let result: unknown;
  let failed: string | undefined;
  let paused = false, cancelled = false;
  for (const event of events.slice(1)) {
    if ((finished || failed || cancelled) && event.kind!=='journal_repair')
      throw new Error('Orchestration journal continues after a terminal event');
    if (event.kind === 'run_paused') {
      if (pending || paused) throw new Error('Invalid orchestration pause');
      paused = true; continue;
    }
    if (event.kind === 'run_resumed') {
      if (pending || !paused) throw new Error('Invalid orchestration resume');
      paused = false; continue;
    }
    if (event.kind === 'run_cancelled') {
      if (pending) throw new Error('Orchestration cancelled with an unresolved command');
      cancelled = true; continue;
    }
    if (paused) throw new Error('Orchestration command recorded while paused');
    if (event.kind === 'command_intent') {
      if (pending || !object(event.request)) throw new Error('Overlapping or invalid orchestration command intents');
      const request = event.request as CommandRequest;
      validateCommand(request);
      const key = commandKey(request);
      if (seen.has(key) || event.key !== key || event.requestHash !== sha256Text(stableJson(request)))
        throw new Error(`Orchestration command identity or hash mismatch: ${key}`);
      if (retry && stableJson(retry) !== stableJson(request))
        throw new Error(`Orchestration retry command history diverged at ${key}`);
      retry = undefined;
      seen.add(key); pending = { request };
    } else if (event.kind === 'command_commit') {
      if (!pending || event.key !== commandKey(pending.request) || !('value' in event))
        throw new Error('Orchestration commit has no matching intent');
      stableJson(event.value);
      committed.push({ request: pending.request, value: event.value }); pending = undefined;
    } else if (event.kind === 'command_error') {
      if (!pending || event.key !== commandKey(pending.request)) throw new Error('Orchestration error has no matching intent');
      pending.message = String(event.message ?? 'Command outcome is uncertain');
      if (event.dispatch !== undefined && (event.dispatch !== 'not_dispatched' || pending.request.kind !== 'step' ||
          event.requestHash !== sha256Text(stableJson(pending.request))))
        throw new Error('Invalid orchestration dispatch evidence');
      pending.dispatch = event.dispatch === 'not_dispatched' ? 'not_dispatched' : undefined;
    } else if (event.kind === 'command_retry') {
      if (!pending || event.key !== commandKey(pending.request) ||
          (!safelyRetryable(pending.request) && pending.dispatch !== 'not_dispatched'))
        throw new Error('Only a pending retryable command can be retried');
      const key=commandKey(pending.request);
      if (safelyRetryable(pending.request)) readRetries.set(key,(readRetries.get(key)??0)+1);
      retry = pending.request;
      seen.delete(key); pending=undefined;
    } else if (event.kind === 'journal_repair') {
      if (typeof event.reason!=='string'||!event.reason.trim()) throw new Error('Journal repair requires a reason');
    } else if (event.kind === 'run_finished') {
      if (pending || retry) throw new Error('Orchestration finished with an unresolved command');
      result = event.result ?? null; finished = true;
    } else if (event.kind === 'run_failed') {
      if (pending) throw new Error('Orchestration failed with an unresolved command');
      failed = String(event.message ?? 'Workflow script failed');
    } else throw new Error(`Unknown orchestration event: ${event.kind}`);
  }
  return { committed, pending, retry, finished, result, failed, readRetries, paused, cancelled };
}

function validateCommand(request: CommandRequest): void {
  if (!object(request) || !keys.has(request.kind) || typeof request.id !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,80}$/.test(request.id) || typeof request.scope !== 'string' ||
      !/^root(?:\/(?:item|desktop):[A-Za-z0-9_.-]{1,80})*$/.test(request.scope))
    throw new Error('Invalid orchestration command identity');
  const encoded=stableJson(request.args ?? null);
  if (Buffer.byteLength(encoded)>256_000) throw new Error('Workflow command args exceed 256 KB');
  if (request.kind==='readInput' && request.args!==null)
    throw new Error('readInput does not accept arguments');
  if (request.kind === 'ask') {
    const args = request.args as AskArgs;
    if (!object(args) || typeof args.question !== 'string' || !args.question.trim() ||
        !Array.isArray(args.choices) || args.choices.length < 2 || args.choices.length > 20 ||
        args.choices.some(choice => typeof choice !== 'string' || !choice.trim()) ||
        new Set(args.choices).size !== args.choices.length) throw new Error('ask requires a question and 2..20 unique choices');
  }
  if (request.kind === 'suno') {
    const args=request.args;
    if (!object(args) || !['inspect','prepare','submit','wait'].includes(String(args.op)))
      throw new Error('Unsupported Suno operation');
    if (args.op === 'prepare' || args.op === 'submit') {
      if (!object(args.song) || !['title','lyrics','style'].every(key=>
        typeof (args.song as Record<string,unknown>)[key] === 'string' &&
        Boolean(String((args.song as Record<string,unknown>)[key]).trim())))
        throw new Error('Suno operation requires title, lyrics and style');
    }
    if (args.op === 'submit' && (!Array.isArray(args.baselineUrls) ||
        args.baselineUrls.some(url=>typeof url!=='string'))) throw new Error('Suno submit requires baselineUrls');
    if (args.op === 'wait' && (!Array.isArray(args.trackUrls) || !args.trackUrls.length ||
        args.trackUrls.some(url=>typeof url!=='string') ||
        !Number.isInteger(args.timeoutMs) || Number(args.timeoutMs)<1 || Number(args.timeoutMs)>60_000))
      throw new Error('Suno wait requires trackUrls and timeoutMs 1..60000');
  }
  if (['observe','step','waitFor'].includes(request.kind) && !request.scope.includes('/desktop:'))
    throw new Error(`${request.kind} must run inside withDesktop`);
  if (['observe','step','waitFor'].includes(request.kind)) {
    const args=request.args;
    if (!object(args) || !object(args.target) || typeof args.target.titleContains!=='string' ||
        !args.target.titleContains.trim() ||
        (args.target.pid!==undefined && (!Number.isInteger(args.target.pid) || Number(args.target.pid)<1)))
      throw new Error(`${request.kind} requires a unique target selector`);
    if (request.kind==='waitFor') {
      if (!Number.isInteger(args.timeoutMs) || Number(args.timeoutMs)<1 || Number(args.timeoutMs)>60_000)
        throw new Error('waitFor timeoutMs must be 1..60000');
      validateCondition(args.expect,'waitFor.expect',true);
    }
    if (request.kind==='step') {
      if (!Array.isArray(args.actions) || args.actions.length<1 || args.actions.length>256)
        throw new Error('step requires 1..256 actions');
      if (args.mode==='batch') {
        if ('profile' in args) throw new Error('Batch steps cannot specify a semantic profile');
        for (const action of args.actions) {
          if (!object(action) || !['click','fill_text','type_text','press_keys'].includes(String(action.type)))
            throw new Error('Unsupported batch action');
          const allowed=action.type==='click'?['type','control','count']:
            action.type==='fill_text'?['type','control','text']:
              action.type==='type_text'?['type','text']:['type','chord'];
          if (Object.keys(action).some(key=>!allowed.includes(key))) throw new Error('Unknown batch action field');
          if (action.type==='click'||action.type==='fill_text') {
            if (!object(action.control) || typeof action.control.name!=='string' || !action.control.name ||
                (action.control.role!==undefined&&typeof action.control.role!=='string') ||
                Object.keys(action.control).some(key=>!['name','role'].includes(key)))
              throw new Error('Batch control action requires a stable control selector');
          }
          if (action.type==='click'&&action.count!==undefined&&action.count!==1&&action.count!==2)
            throw new Error('Batch click count must be 1 or 2');
          if (action.type==='fill_text'||action.type==='type_text') {
            if (typeof action.text!=='string') throw new Error('Batch text action requires text');
          }
          if (action.type==='press_keys' && (typeof action.chord!=='string'||!action.chord))
            throw new Error('Batch key action requires chord');
        }
      } else {
        if (args.mode!==undefined&&args.mode!=='semantic') throw new Error('Unknown step mode');
        if (typeof args.profile!=='string' || !args.profile) throw new Error('Semantic step requires a profile');
        for (const action of args.actions) if (!object(action) || typeof action.action!=='string' ||
            !action.action || !object(action.args) || Object.keys(action).some(key=>!['action','args'].includes(key)))
          throw new Error('Each semantic action requires action and args');
      }
      validateCondition(args.before,'step.before',true);
      validateCondition(args.expect,'step.expect',true);
      if (args.timeoutMs!==undefined && (!Number.isInteger(args.timeoutMs) || Number(args.timeoutMs)<1 || Number(args.timeoutMs)>60_000))
        throw new Error('step timeoutMs must be 1..60000');
    }
  }
}

function report(definition: OrchestrationDefinition, runDirectory: string, history: History,
  active: boolean): OrchestrationReport {
  let status: OrchestrationStatus = history.finished ? 'completed' : history.failed ? 'failed' :
    history.cancelled ? 'cancelled' : history.paused ? 'paused' :
    active && history.pending ? 'running' :
    history.pending?.request.kind === 'ask' ? 'waiting_decision' :
    history.pending?.dispatch === 'not_dispatched' ? 'retry_available' :
    history.pending ? 'needs_reconciliation' : 'running';
  return { schemaVersion: 1, name: definition.name, status,
    commandCount: history.committed.length + (history.pending ? 1 : 0),
    committedCount: history.committed.length,
    ...(history.pending ? { pending: { key: commandKey(history.pending.request), kind: history.pending.request.kind,
      args: history.pending.request.args,
      ...(history.pending.dispatch ? {dispatch:history.pending.dispatch} : {}) } } : {}),
    ...(history.pending?.message || history.failed || (!active && status === 'running' ? 'Interrupted; resume is available' : undefined)
      ? { message: history.pending?.message ?? history.failed ?? 'Interrupted; resume is available' } : {}),
    ...(history.finished ? {result:history.result} : {}),
    runDirectory };
}

async function load(runDirectory: string, allowIncompleteTail = false): Promise<{
  definition: OrchestrationDefinition; events: WorkflowEvent[]; history: History; incompleteTail: boolean }> {
  await assertExistingDirectoryNoLinks(runDirectory);
  const definition = JSON.parse(await readFile(join(runDirectory,'definition.json'),'utf8')) as OrchestrationDefinition;
  if (!definition || definition.schemaVersion !== 1 || !definition.name || !definition.script ||
      (definition.desktopResultContract !== undefined && definition.desktopResultContract !== 'desktop-v1') ||
      !/^[a-f0-9]{64}$/.test(definition.scriptSha256) ||
      sha256Text(stableJson(definition.input)) !== definition.inputSha256)
    throw new Error('Frozen orchestration definition is invalid');
  const source=await readFile(join(runDirectory,'execution.jsonl'),'utf8');
  const incompleteTail=!source.endsWith('\n');
  if (incompleteTail&&!allowIncompleteTail) throw new Error('Orchestration journal has an incomplete final event');
  let events: WorkflowEvent[];
  if (!incompleteTail) events=await readWorkflowEvents(runDirectory);
  else {
    const lastNewline=source.lastIndexOf('\n');
    if (lastNewline<0) throw new Error('Orchestration journal has no complete event');
    events=source.slice(0,lastNewline+1).split(/\r?\n/).filter(Boolean).map((line,index) => {
      let event: WorkflowEvent;
      try {event=JSON.parse(line) as WorkflowEvent;}
      catch {throw new Error(`Orchestration journal event ${index+1} is invalid JSON`);}
      if (!object(event)||event.seq!==index+1||typeof event.kind!=='string'||typeof event.time!=='string')
        throw new Error(`Orchestration journal sequence is invalid at ${index+1}`);
      return event;
    });
  }
  return { definition, events, history: inspectEvents(definition,events), incompleteTail };
}

export async function orchestrationStatus(runDirectory: string): Promise<OrchestrationReport> {
  const root = resolve(runDirectory);
  const { definition, history, incompleteTail } = await load(root,true);
  const result=report(definition,root,history,await isRunLockActive(root));
  return incompleteTail ? {...result,status:'needs_reconciliation',
    message:'Journal has an incomplete final event; explicit repair is required'} : result;
}

export async function repairOrchestrationTail(runDirectory: string, reason: string): Promise<OrchestrationReport> {
  if (!reason.trim()) throw new Error('Journal repair requires a reason');
  const root=resolve(runDirectory);
  await assertExistingDirectoryNoLinks(root);
  const release=await acquireRunLock(root);
  try {
    const inspected=await load(root,true);
    if (!inspected.incompleteTail) throw new Error('Orchestration journal has no incomplete tail');
    await preserveAndTruncateIncompleteTail(root);
    const journal=await WorkflowJournal.appendExisting(root);
    try {await journal.append({kind:'journal_repair',reason});}
    finally {await journal.close();}
    const {definition,history}=await load(root);
    return report(definition,root,history,false);
  } finally {await release();}
}

async function execute(definition: OrchestrationDefinition, runDirectory: string, host: OrchestrationHost,
  lockAlreadyHeld = false): Promise<OrchestrationReport> {
  await assertExistingDirectoryNoLinks(runDirectory);
  const release = lockAlreadyHeld ? async () => {} : await acquireRunLock(runDirectory);
  let journal: WorkflowJournal | undefined;
  try {
    if (await sha256File(definition.script) !== definition.scriptSha256)
      throw new Error('Trusted workflow script changed; create a new run');
    const loaded = await load(runDirectory);
    if (loaded.history.pending && (safelyRetryable(loaded.history.pending.request) ||
        loaded.history.pending.dispatch === 'not_dispatched')) {
      const key=commandKey(loaded.history.pending.request);
      if ((loaded.history.readRetries.get(key)??0)>=3) throw new Error(`${key} exceeded three read-only recovery attempts`);
      const retryJournal=await WorkflowJournal.appendExisting(runDirectory);
      try { loaded.events.push(await retryJournal.append({kind:'command_retry',key,
        reason:loaded.history.pending.dispatch === 'not_dispatched' ?
          'Explicit resume of a command rejected before input dispatch' :
          'Retryable command may safely be repeated after interruption'})); }
      finally { await retryJournal.close(); }
      loaded.history=inspectEvents(definition,loaded.events);
    }
    if (loaded.history.pending) throw new Error(`${commandKey(loaded.history.pending.request)} needs a decision or reconciliation`);
    if (loaded.history.failed) throw new Error(`Workflow is terminal: ${loaded.history.failed}`);
    if (loaded.history.cancelled) throw new Error('Cancelled workflow is terminal');
    if (loaded.history.finished) return report(definition,runDirectory,loaded.history,false);
    journal = await WorkflowJournal.appendExisting(runDirectory);
    const events = loaded.events;
    if (loaded.history.paused) {
      await consumeControlRequest(runDirectory);
      events.push(await journal.append({kind:'run_resumed'}));
    }
    const prior = loaded.history.committed;
    let retry = loaded.history.retry;
    let replayIndex = 0;
    const seen = new Set<string>();
    let stop: OrchestrationStatus | undefined;
    let message: string | undefined;
    const append = async (kind: string, fields: Record<string,unknown>) => {
      const event = await journal!.append({ kind, ...fields }); events.push(event);
    };
    const worker = fork(fileURLToPath(new URL('./script-worker.js',import.meta.url)),
      [definition.script,definition.scriptSha256], {
        execArgv: [], env: { ...process.env, [ORCHESTRATION_WORKER_MARKER]: '1' },
        stdio: ['ignore','ignore','pipe','ipc'], windowsHide: true
      });
    let stderr = '';
    worker.stderr?.on('data',(bytes: Buffer) => { stderr += bytes.toString('utf8').slice(0,Math.max(0,4096-stderr.length)); });
    let chain = Promise.resolve();
    const send = (id: number, ok: boolean, value?: unknown, error?: string) =>
      worker.connected && worker.send({ type:'reply', id, ok, value, error });
    const handle = async (messageValue: unknown): Promise<void> => {
      if (!object(messageValue)) return;
      if (stop) return;
      const type = messageValue.type;
      if (type === 'ready') { worker.send({type:'start'}); return; }
      if (type === 'desktop_end') {
        await host.releaseDesktop?.();
        send(Number(messageValue.id),true,null); return;
      }
      if (type === 'fatal') {
        if (!stop) {
          message = String(messageValue.error ?? 'Workflow script failed');
          const uncertain = inspectEvents(definition,events).pending;
          if (uncertain) {
            await append('command_error',{key:commandKey(uncertain.request),message});
            stop = 'needs_reconciliation';
          } else { await append('run_failed',{message}); stop = 'failed'; }
        }
        worker.kill(); return;
      }
      if (type === 'finished') {
        if (replayIndex !== prior.length) throw new Error('Workflow ended before consuming its recorded command history');
        if (retry) throw new Error('Workflow ended before retrying its recorded command');
        stableJson(messageValue.value ?? null);
        await append('run_finished',{result:messageValue.value ?? null}); stop = 'completed';
        worker.kill(); return;
      }
      if (type !== 'command') return;
      const request = normalized(messageValue.request as CommandRequest);
      validateCommand(request);
      const key = commandKey(request);
      if (seen.has(key)) throw new Error(`Duplicate workflow command id: ${key}`);
      seen.add(key);
      const id = Number(messageValue.id);
      if (replayIndex < prior.length) {
        const old = prior[replayIndex++];
        if (stableJson(old.request) !== stableJson(request))
          throw new Error(`Workflow command history diverged at ${key}`);
        send(id,true,old.value); return;
      }
      if (seen.size > maxCommands) throw new Error('Workflow command count limit exceeded');
      if (retry && stableJson(retry) !== stableJson(request))
        throw new Error(`Workflow retry command history diverged at ${key}`);
      const control=await readControlRequest(runDirectory);
      if (control) {
        await append(control==='pause'?'run_paused':'run_cancelled',
          {message:`${control} requested at a command boundary`});
        stop=control==='pause'?'paused':'cancelled'; worker.kill(); return;
      }
      await append('command_intent',{key,request,requestHash:sha256Text(stableJson(request))});
      retry = undefined;
      if (request.kind === 'ask') { stop = 'waiting_decision'; worker.kill(); return; }
      let notDispatched = false;
      try {
        let value: unknown;
        try {
          value = request.kind === 'readInput' ? definition.input :
            request.kind === 'checkpoint' ? request.args : await host.execute(request);
        } catch (error) {
          notDispatched = request.kind === 'step' && error instanceof CommandNotDispatchedError;
          throw error;
        }
        stableJson(value);
        await append('command_commit',{key,value});
        send(id,true,value);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        await append('command_error',{key,message,...(notDispatched ?
          {dispatch:'not_dispatched',requestHash:sha256Text(stableJson(request))} : {})});
        stop = 'needs_reconciliation'; worker.kill();
      }
    };
    const finished = await new Promise<void>(resolvePromise => {
      const timer = setTimeout(() => { message = `Workflow exceeded ${maxRunMs} ms`; worker.kill(); },maxRunMs);
      worker.on('message',value => { chain = chain.then(()=>handle(value)).catch(async error => {
        message = error instanceof Error ? error.message : String(error);
        try {
          const uncertain = inspectEvents(definition,events).pending;
          if (uncertain) {
            await append('command_error',{key:commandKey(uncertain.request),message});
            stop = 'needs_reconciliation';
          } else { await append('run_failed',{message}); stop = 'failed'; }
        } catch { /* A damaged journal remains available for explicit repair. */ }
        worker.kill();
      }); });
      worker.once('close',() => { clearTimeout(timer); void chain.finally(resolvePromise); });
      worker.once('error',error => { message = error.message; worker.kill(); });
    });
    void finished;
    await host.releaseDesktop?.();
    // A worker crash is not a script-level failure. The durable intent, if any,
    // remains unresolved; a clean committed prefix can be replayed on resume.
    if (!stop) message ??= stderr || 'Workflow worker stopped without a final result';
    const history = inspectEvents(definition,events);
    return report(definition,runDirectory,history,false);
  } finally { await host.releaseDesktop?.(); await journal?.close(); await release(); }
}

export async function startOrchestration(name: string, script: string, input: unknown,
  runDirectory: string, host: OrchestrationHost): Promise<OrchestrationReport> {
  if (!name.trim()) throw new Error('Workflow name is required');
  stableJson(input);
  const root = resolve(runDirectory);
  await ensureDirectoryNoLinks(dirname(root));
  await mkdir(root);
  const release=await acquireRunLock(root);
  try {
    const scriptPath = resolve(script);
    const definition: OrchestrationDefinition = { schemaVersion:1,name,script:scriptPath,
      scriptSha256:await sha256File(scriptPath),input,inputSha256:sha256Text(stableJson(input)),
      createdAt:new Date().toISOString(),...(host.desktopResultContract ?
        {desktopResultContract:host.desktopResultContract} : {}) };
    await writeAtomicJson(join(root,'definition.json'),definition);
    const journal = await WorkflowJournal.create(root);
    try { await journal.append({kind:'run_started',runId:randomUUID(),
      scriptSha256:definition.scriptSha256,inputSha256:definition.inputSha256}); }
    finally { await journal.close(); }
    return await execute(definition,root,host,true);
  } finally {await release();}
}

export async function resumeOrchestration(runDirectory: string, host: OrchestrationHost): Promise<OrchestrationReport> {
  const root = resolve(runDirectory);
  const { definition } = await load(root);
  return execute(definition,root,host);
}

export async function answerOrchestration(runDirectory: string, choice: string): Promise<OrchestrationReport> {
  const root = resolve(runDirectory);
  await assertExistingDirectoryNoLinks(root);
  const release = await acquireRunLock(root);
  try {
    const { definition, history, events } = await load(root);
    if (history.pending?.request.kind !== 'ask') throw new Error('Workflow is not waiting for an answer');
    const args = history.pending.request.args as AskArgs;
    if (!args.choices.includes(choice)) throw new Error('Answer must be one of the recorded choices');
    const journal = await WorkflowJournal.appendExisting(root);
    try { events.push(await journal.append({kind:'command_commit',key:commandKey(history.pending.request),value:choice,
      answeredBy:'user'})); }
    finally { await journal.close(); }
    return report(definition,root,inspectEvents(definition,events),false);
  } finally { await release(); }
}

export async function reconcileOrchestration(runDirectory: string, key: string, value: unknown,
  reason: string): Promise<OrchestrationReport> {
  if (!reason.trim()) throw new Error('Manual reconciliation requires a reason');
  stableJson(value);
  const root = resolve(runDirectory);
  await assertExistingDirectoryNoLinks(root);
  const release = await acquireRunLock(root);
  try {
    const { definition, history, events } = await load(root);
    if (!history.pending || commandKey(history.pending.request) !== key || history.pending.request.kind === 'ask')
      throw new Error('Only the current uncertain command can be reconciled');
    if (definition.desktopResultContract === 'desktop-v1')
      validateDesktopReconciliation(history.pending.request,value);
    const journal = await WorkflowJournal.appendExisting(root);
    try { events.push(await journal.append({kind:'command_commit',key,value,
      verification:'manual_acceptance',reason})); }
    finally { await journal.close(); }
    return report(definition,root,inspectEvents(definition,events),false);
  } finally { await release(); }
}
