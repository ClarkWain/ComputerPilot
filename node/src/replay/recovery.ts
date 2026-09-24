import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '../native/client.js';
import type { ReplayRecipe } from './recipe.js';

export type RunInspection = { state:'resumable'|'complete'|'needs_reconciliation';
  committed:number; nextStep?:string; verification:'verified'|'partial'; reason?:string };
const obj=(value:unknown):JsonObject=>value && typeof value==='object' && !Array.isArray(value)
  ?value as JsonObject:{};
export const recipeHash=(recipe:ReplayRecipe):string=>createHash('sha256')
  .update(JSON.stringify(recipe)).digest('hex');

export async function inspectRun(directory:string,recipe:ReplayRecipe):Promise<RunInspection> {
  const path=join(directory,'execution.jsonl');
  if ((await stat(path)).size>50_000_000) throw new Error('Replay journal exceeds 50 MB');
  const source=await readFile(path,'utf8');
  const incompleteTail=!source.endsWith('\n');
  const lines=source.trimEnd().split(/\r?\n/);
  if (incompleteTail) lines.pop();
  if (lines.length<1 || lines.length>100000) throw new Error('Replay journal event count is invalid');
  const entries:JsonObject[]=lines.map(line=>obj(JSON.parse(line)));
  const first=entries[0];
  if (first.kind!=='start' || first.recipeHash!==recipeHash(recipe))
    throw new Error('Replay journal belongs to another recipe or predates checkpoint hashes');
  let committed=0,pending='',receipt=false,postcondition=false,fullyVerified=true,finished=false;
  for (const entry of entries.slice(1)) {
    const kind=String(entry.kind??'');
    if (kind==='precondition' || kind==='resume' || kind==='stopped') continue;
    if (kind==='intent') {
      if (pending || entry.step!==recipe.steps[committed]?.id)
        return {state:'needs_reconciliation',committed,verification:'partial',reason:'Unexpected intent order'};
      pending=String(entry.step);receipt=false;postcondition=false;
    } else if (kind==='receipt') {
      const result=obj(entry.result);
      const step=recipe.steps[committed];
      const expectedCount=step.actions?.length??1;
      if (!pending || entry.step!==pending || receipt || result.status!=='ok' || result.completed!==expectedCount)
        return {state:'needs_reconciliation',committed,verification:'partial',reason:'Input outcome is uncertain'};
      receipt=true;
    } else if (kind==='settled') {
      if (!pending || entry.step!==pending || !receipt || postcondition)
        return {state:'needs_reconciliation',committed,verification:'partial',reason:'Visual settling order is invalid'};
    } else if (kind==='postcondition') {
      if (!pending || entry.step!==pending || !receipt || entry.passed!==true)
        return {state:'needs_reconciliation',committed,verification:'partial',reason:'Postcondition was not confirmed'};
      postcondition=true;
    } else if (kind==='commit') {
      if (!pending || entry.step!==pending || !receipt || !postcondition)
        return {state:'needs_reconciliation',committed,verification:'partial',reason:'Incomplete step checkpoint'};
      if (entry.verification!=='file_hash_checked') fullyVerified=false;
      committed++;pending='';receipt=false;postcondition=false;
    } else if (kind==='finished') {
      if (pending || committed!==recipe.steps.length)
        return {state:'needs_reconciliation',committed,verification:'partial',reason:'Finished marker is inconsistent'};
      finished=true;
    } else return {state:'needs_reconciliation',committed,verification:'partial',reason:`Unknown journal event: ${kind}`};
  }
  const verification=fullyVerified?'verified':'partial';
  if (incompleteTail) return {state:'needs_reconciliation',committed,verification:'partial',
    reason:'Journal ends with an incomplete event'};
  if (pending) return {state:'needs_reconciliation',committed,verification:'partial',
    reason:`Action ${pending} may already have changed the desktop`};
  if (finished || committed===recipe.steps.length) return {state:'complete',committed,verification};
  return {state:'resumable',committed,nextStep:recipe.steps[committed].id,verification};
}

export function hasStrongResumeBaseline(recipe:ReplayRecipe,index:number):boolean {
  const before=recipe.steps[index]?.before;
  return Boolean(before?.file?.sha256 || before?.capture?.reference || before?.control?.value!==undefined);
}
