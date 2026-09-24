import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { operationFailed } from '../agent/api.js';
import type { JsonObject } from '../native/client.js';
import { acquireDesktopLock } from './lock.js';
import type { ReplayRecipe } from './recipe.js';
import { conditionProblems } from './conditions.js';
import { hasStrongResumeBaseline, inspectRun, recipeHash } from './recovery.js';
import { checkCapture, waitForStableImage } from './visual.js';

export type ReplayApi = { call(tool: string, args: JsonObject): Promise<JsonObject> };
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter(x => x && typeof x === 'object') as JsonObject[] : [];
function expand(value: unknown, runDirectory: string, sourceDirectory: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{{runDir}}', resolve(runDirectory))
    .replaceAll('{{assetDir}}', resolve(sourceDirectory,'assets'));
  if (Array.isArray(value)) return value.map(x => expand(x, runDirectory, sourceDirectory));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,expand(v,runDirectory,sourceDirectory)]));
  return value;
}
function requireOk(result: JsonObject, stage: string): void {
  if (operationFailed(result) || result.status !== 'ok') throw new Error(`${stage}: ${JSON.stringify(result)}`);
}
export async function runReplay(api: ReplayApi, recipe: ReplayRecipe, runDirectory: string,
  sourceDirectory = runDirectory, resume=false): Promise<{ verification: 'verified' | 'partial' }> {
  let startIndex=0,fullyVerified=true;
  if (resume) {
    const inspection=await inspectRun(runDirectory,recipe);
    if (inspection.state!=='resumable')
      throw new Error(`Replay cannot resume: ${inspection.reason??inspection.state}`);
    startIndex=inspection.committed;
    if (!hasStrongResumeBaseline(recipe,startIndex))
      throw new Error(`Replay cannot resume ${inspection.nextStep}: a document-specific before condition is required`);
    fullyVerified=inspection.verification==='verified';
  } else await mkdir(runDirectory, { recursive: false });
  const journal = await open(resolve(runDirectory, 'execution.jsonl'), resume?'a':'wx');
  let release: (() => Promise<void>) | undefined;
  const event = async (entry: JsonObject): Promise<void> => {
    await journal.writeFile(JSON.stringify({ time: new Date().toISOString(), ...entry })+'\n');
    await journal.sync();
  };
  try {
    release = await acquireDesktopLock();
    await event(resume?{kind:'resume',from:recipe.steps[startIndex].id}:
      { kind: 'start', recipe: recipe.name, recipeHash:recipeHash(recipe) });
    for (const step of recipe.steps.slice(startIndex)) {
      const list = await api.call('list_windows', {});requireOk(list, `${step.id}: list_windows`);
      const matches = objects(list.windows).filter(x => String(x.title ?? '').includes(recipe.target.titleContains) &&
        (recipe.target.pid === undefined || x.pid === recipe.target.pid));
      if (matches.length !== 1) throw new Error(`${step.id}: target must match exactly one window; found ${matches.length}`);
      const windowId = String(matches[0].window_id);
      const before = await api.call('get_window_state', { window_id: windowId, mode: 'controls', detail: 'full' });
      requireOk(before, `${step.id}: precondition`);
      if (!objects((before.semantic as JsonObject)?.profiles).some(x => x.id === step.profile))
        throw new Error(`${step.id}: profile ${step.profile} is unavailable`);
      if (step.before) {
        const problems=await conditionProblems(step.before,before,runDirectory,sourceDirectory);
        if (step.before.capture) try {
          await checkCapture(api,windowId,before,step.before.capture,runDirectory,sourceDirectory);
        } catch(error) { problems.push(error instanceof Error?error.message:String(error)); }
        if (problems.length) throw new Error(`${step.id}: precondition failed: ${problems.join('; ')}`);
      }
      await event({ kind:'precondition', step:step.id, passed:true });
      const actions=step.actions??[step.action!];
      await event({ kind: 'intent', step: step.id, actions: actions.map(action=>action.action) });
      const dispatchedAt=Date.now();
      const result = await api.call('execute_semantic', { window_id: windowId, profile: step.profile,
        actions: actions.map(action=>expand(action, runDirectory, sourceDirectory)) });
      await event({ kind: 'receipt', step: step.id, result,elapsedMs:Date.now()-dispatchedAt });
      // An unsuccessful receipt may still mean that input took effect. Stop without retry.
      requireOk(result, `${step.id}: dispatch outcome requires inspection`);
      if (result.completed !== actions.length) throw new Error(`${step.id}: semantic action count was not confirmed`);
      if (step.settle) {
        const settled=await waitForStableImage(api,windowId,step.settle);
        await event({kind:'settled',step:step.id,...settled});
      }
      const deadline=Date.now()+(step.settleTimeoutMs??10000);
      let polls=0;let problems:string[]=[];
      do {
        const after=await api.call('get_window_state',{window_id:windowId,mode:'controls',detail:'full'});
        requireOk(after,`${step.id}: postcondition observation`);
        polls++;
        problems=await conditionProblems(step.expect,after,runDirectory,sourceDirectory);
        if (!problems.length && step.expect.capture) try {
          await checkCapture(api,windowId,after,step.expect.capture,runDirectory,sourceDirectory);
        } catch(error) {problems.push(error instanceof Error?error.message:String(error));}
        if (!problems.length) break;
        if (Date.now()>=deadline) throw new Error(`${step.id}: postcondition timed out: ${problems.join('; ')}`);
        await delay(Math.min(250,Math.max(1,deadline-Date.now())));
      } while(true);
      await event({kind:'postcondition',step:step.id,passed:true,polls});
      if (!step.expect.file?.sha256) fullyVerified=false;
      await event({ kind: 'commit', step: step.id,
        verification: step.expect.file?.sha256 ? 'file_hash_checked' :
          step.expect.file?.samples ? 'file_samples_checked' :
          step.expect.file ? 'file_metadata_only' : 'profile_compatibility_only' });
    }
    const verification=fullyVerified?'verified':'partial';
    await event({ kind: 'finished', verification });
    return {verification};
  } catch (error) {
    await event({ kind: 'stopped', reason: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { await release?.();await journal.close(); }
}
