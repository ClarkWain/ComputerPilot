import { stat } from 'node:fs/promises';
import { assetPath, checkFile, type ReplayCondition } from './recipe.js';
import type { JsonObject } from '../native/client.js';

const objects=(value:unknown):JsonObject[]=>Array.isArray(value)
  ?value.filter(item=>item && typeof item==='object' && !Array.isArray(item)) as JsonObject[]:[];

export async function conditionProblems(condition: ReplayCondition, state: JsonObject,
  runDirectory: string, sourceDirectory = runDirectory): Promise<string[]> {
  const problems:string[]=[];
  if (condition.titleContains && !String(state.title??'').includes(condition.titleContains))
    problems.push(`Window title does not contain ${condition.titleContains}`);
  if (condition.profileAvailable && !objects((state.semantic as JsonObject)?.profiles)
    .some(item=>item.id===condition.profileAvailable))
    problems.push(`Profile unavailable: ${condition.profileAvailable}`);
  if (condition.control) {
    const expected=condition.control;
    const matches=objects(state.controls).filter(item=>item.name===expected.name &&
      (expected.role===undefined || item.role===expected.role) &&
      item.enabled!==false && item.offscreen!==true);
    if (matches.length!==1) problems.push(`Expected one visible control ${expected.name}; found ${matches.length}`);
    else if (expected.value!==undefined && matches[0].value!==expected.value)
      problems.push(`Control value mismatch: ${expected.name}`);
  }
  if (condition.file) {
    try { await checkFile(runDirectory,condition.file,sourceDirectory); }
    catch(error) { problems.push(error instanceof Error?error.message:String(error)); }
  }
  if (condition.fileAbsent) {
    try { await stat(assetPath(runDirectory,condition.fileAbsent));
      problems.push(`File already exists: ${condition.fileAbsent}`);
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code!=='ENOENT')
        problems.push(error instanceof Error?error.message:String(error));
    }
  }
  return problems;
}
