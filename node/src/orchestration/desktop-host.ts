import { setTimeout as delay } from 'node:timers/promises';
import { operationFailed } from '../agent/api.js';
import type { JsonObject } from '../native/client.js';
import { conditionProblems } from '../replay/conditions.js';
import { acquireDesktopLock } from '../replay/lock.js';
import type { ReplayApi } from '../replay/runner.js';
import { checkCapture } from '../replay/visual.js';
import { validateCondition, type ReplayCondition } from '../replay/recipe.js';
import type { CommandRequest, ObserveArgs, OrchestrationHost, StepArgs, Target, WaitArgs } from './types.js';
import { CommandNotDispatchedError } from './types.js';

const objects = (value: unknown): JsonObject[] => Array.isArray(value) ?
  value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as JsonObject[] : [];
const object = (value: unknown): value is Record<string,unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const requireOk = (value: JsonObject, stage: string): void => {
  if (operationFailed(value) || value.status !== 'ok') throw new Error(`${stage}: ${JSON.stringify(value)}`);
};
function targetOf(value: unknown): Target {
  if (!object(value) || typeof value.titleContains !== 'string' || !value.titleContains.trim() ||
      (value.pid !== undefined && (!Number.isInteger(value.pid) || Number(value.pid) < 1)))
    throw new Error('Desktop target requires titleContains and an optional positive pid');
  return value as Target;
}
function logicalState(state: JsonObject): JsonObject {
  const semantic = state.semantic as JsonObject | undefined;
  // Native observations are JSON; omit absent optional fields before persisting
  // the logical snapshot as a replayable command result.
  return JSON.parse(JSON.stringify({ title: state.title, pid: state.pid,
    controls: objects(state.controls).map(control => ({ name:control.name,role:control.role,
      value:control.value,enabled:control.enabled,offscreen:control.offscreen })),
    semantic: { profiles: objects(semantic?.profiles).map(profile => ({ id:profile.id })) },
    inspection: state.inspection ?? null })) as JsonObject;
}

/** Desktop commands share Replay conditions and its input lock, but retain their own durable command history. */
export function createDesktopOrchestrationHost(api: ReplayApi, runDirectory: string,
  sourceDirectory = runDirectory, lock: typeof acquireDesktopLock = acquireDesktopLock): OrchestrationHost {
  let release: (() => Promise<void>) | undefined;
  const ensureLease = async (): Promise<void> => { release ??= await lock(); };
  const releaseDesktop = async (): Promise<void> => {
    const held = release; release = undefined; await held?.();
  };
  const locate = async (target: Target): Promise<string> => {
    const list = await api.call('list_windows',{});
    requireOk(list,'list_windows');
    const matches = objects(list.windows).filter(window => String(window.title ?? '').includes(target.titleContains) &&
      (target.pid === undefined || window.pid === target.pid));
    if (matches.length !== 1) throw new Error(`Target must match one window; found ${matches.length}`);
    return String(matches[0].window_id);
  };
  const observe = async (windowId: string): Promise<JsonObject> => {
    const result = await api.call('get_window_state',{window_id:windowId,mode:'controls',detail:'full'});
    requireOk(result,'get_window_state');
    return result;
  };
  const problems = async (condition: ReplayCondition, state: JsonObject, windowId: string): Promise<string[]> => {
    const found = await conditionProblems(condition,state,runDirectory,sourceDirectory);
    if (!found.length && condition.capture) try {
      await checkCapture(api,windowId,state,condition.capture,runDirectory,sourceDirectory);
    } catch(error) { found.push(error instanceof Error?error.message:String(error)); }
    return found;
  };
  return {
    desktopResultContract: 'desktop-v1',
    releaseDesktop,
    async execute(request: CommandRequest): Promise<unknown> {
      let dispatchStarted = false;
      try {
      if (!['observe','step','waitFor'].includes(request.kind)) throw new Error(`Unsupported desktop command: ${request.kind}`);
      await ensureLease();
      const args = request.args as ObserveArgs | StepArgs | WaitArgs;
      if (!object(args)) throw new Error('Desktop command args must be an object');
      const target = targetOf(args.target);
      let windowId = await locate(target);
      if (request.kind === 'observe') return logicalState(await observe(windowId));
      if (request.kind === 'waitFor') {
        const wait = args as WaitArgs;
        if (!Number.isInteger(wait.timeoutMs) || wait.timeoutMs < 1 || wait.timeoutMs > 60_000)
          throw new Error('waitFor requires an observable condition and timeoutMs 1..60000');
        validateCondition(wait.expect,'waitFor.expect',true);
        const deadline = Date.now() + wait.timeoutMs;
        while (true) {
          windowId = await locate(target);
          const state = await observe(windowId);
          const found = await problems(wait.expect,state,windowId);
          if (!found.length) return logicalState(state);
          if (Date.now() >= deadline) throw new Error(`waitFor timed out: ${found.join('; ')}`);
          await delay(Math.min(250,Math.max(1,deadline-Date.now())));
        }
      }
      const step = args as StepArgs;
      if (!Array.isArray(step.actions) || step.actions.length < 1 || step.actions.length > 256)
        throw new Error('step requires 1..256 actions and an observable expect condition');
      validateCondition(step.before,'step.before',true);
      validateCondition(step.expect,'step.expect',true);
      const timeoutMs = step.timeoutMs ?? 10_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
        throw new Error('step timeoutMs must be 1..60000');
      const before = await observe(windowId);
      if (step.mode !== 'batch' && !objects((before.semantic as JsonObject)?.profiles)
        .some(profile => profile.id === step.profile)) throw new Error(`Profile unavailable: ${step.profile}`);
      const beforeProblems = await problems(step.before,before,windowId);
      if (beforeProblems.length) throw new Error(`Precondition failed: ${beforeProblems.join('; ')}`);
      let receipt: JsonObject;
      if (step.mode === 'batch') {
        const controls=objects(before.controls);
        const actions=step.actions.map(action => {
          if (action.type==='type_text') return {type:'type_text',text:action.text};
          if (action.type==='press_keys') return {type:'press_keys',chord:action.chord};
          const matches=controls.filter(control => control.name===action.control.name &&
            (action.control.role===undefined||control.role===action.control.role) &&
            control.enabled!==false && control.offscreen!==true && typeof control.control_id==='string');
          if (matches.length!==1) throw new Error(`Expected one current control ${action.control.name}; found ${matches.length}`);
          return action.type==='click'
            ? {type:'click',control_id:matches[0].control_id,...(action.count?{count:action.count}:{})}
            : {type:'fill_text',control_id:matches[0].control_id,text:action.text};
        });
        dispatchStarted = true;
        receipt=await api.call('execute_batch',{window_id:windowId,actions});
      } else {
        dispatchStarted = true;
        receipt=await api.call('execute_semantic',{window_id:windowId,profile:step.profile,actions:step.actions});
      }
      requireOk(receipt,step.mode==='batch'?'execute_batch':'execute_semantic');
      if (receipt.completed !== step.actions.length) throw new Error('Semantic action count was not confirmed');
      const deadline = Date.now() + timeoutMs;
      while (true) {
        windowId = await locate(target);
        const after = await observe(windowId);
        const found = await problems(step.expect,after,windowId);
        if (!found.length) return { status:'verified', title:after.title,
          verification: step.expect.file?.sha256 ? 'file_hash_checked' :
            step.expect.file ? 'file_checked' : step.expect.control ? 'control_checked' : 'condition_checked' };
        if (Date.now() >= deadline) throw new Error(`Postcondition timed out: ${found.join('; ')}`);
        await delay(Math.min(250,Math.max(1,deadline-Date.now())));
      }
      } catch (error) {
        if (request.kind === 'step' && !dispatchStarted)
          throw new CommandNotDispatchedError(error instanceof Error ? error.message : String(error), { cause:error });
        if (error instanceof CommandNotDispatchedError) throw new Error(error.message, { cause:error });
        throw error;
      }
    }
  };
}
