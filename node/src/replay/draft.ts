import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { JsonObject } from '../native/client.js';
import type { ReplayRecipe, ReplayStep } from './recipe.js';
import { operationFailed } from '../agent/api.js';

const obj=(value:unknown):JsonObject=>value && typeof value==='object' && !Array.isArray(value)
  ?value as JsonObject:{};
const text=(value:unknown):string=>typeof value==='string'?value:'';

/** Produce a reviewable draft, never a verified replay, from an opt-in MCP intent journal. */
export async function draftFromRecording(journalPath:string,outputDirectory:string):Promise<number> {
  if ((await stat(journalPath)).size>50_000_000) throw new Error('Recording exceeds 50 MB');
  const source=await readFile(journalPath,'utf8');
  if (source.length>50_000_000) throw new Error('Recording exceeds 50 MB');
  const lines=source.trim().split(/\r?\n/);
  if (!lines.length || lines.length>20000) throw new Error('Recording must contain 1..20000 events');
  const intents=new Map<string,JsonObject>();
  const receipts=new Map<string,JsonObject>();
  const order:string[]=[];
  for (const line of lines) {
    const entry=obj(JSON.parse(line));
    const id=text(entry.id);
    if (!id) throw new Error('Recording event lacks id');
    if (entry.kind==='intent') {
      if (intents.has(id)) throw new Error(`Duplicate recording intent: ${id}`);
      intents.set(id,entry);order.push(id);
    } else if (entry.kind==='receipt') {
      if (!intents.has(id) || receipts.has(id)) throw new Error(`Unmatched recording receipt: ${id}`);
      receipts.set(id,obj(entry.result));
    } else throw new Error(`Unknown recording event kind: ${String(entry.kind)}`);
  }
  const steps:ReplayStep[]=[];
  const outputs=new Set<string>();
  let targetTitle='';
  for (const id of order) {
    const intent=intents.get(id)!;
    const result=receipts.get(id);
    if (!result) throw new Error(`Action outcome is unknown; inspect before drafting: ${id}`);
    if (result.status!=='ok' || operationFailed(result)) {
      if (result.dispatch==='not_started') continue;
      throw new Error(`Action may have changed the desktop; inspect before drafting: ${id}`);
    }
    if (intent.tool!=='execute_semantic')
      throw new Error(`Recorded ${String(intent.tool)} cannot be translated into a portable semantic step`);
    const target=obj(intent.target),title=text(target.title);
    if (!title) throw new Error('Recorded target title is missing; observe the window before recording actions');
    if (targetTitle && targetTitle!==title) throw new Error('Recording uses changing target titles; review binding manually');
    targetTitle=title;
    const args=obj(intent.args),actions=args.actions;
    if (!Array.isArray(actions) || actions.length<1 || actions.length>256 || result.completed!==actions.length ||
      (result.dispatch!==undefined && result.dispatch!=='returned'))
      throw new Error('Drafting requires 1..256 fully confirmed semantic actions per recorded call');
    const profile=text(result.profile);
    if (!profile || (args.profile!==undefined && args.profile!==profile))
      throw new Error('Recorded semantic profile was not confirmed by the receipt');
    const expect:ReplayStep['expect']={profileAvailable:profile};
    const translated=actions.map(raw=>{
      const action=obj(raw),actionName=text(action.action),actionArgs={...obj(action.args)};
      if (!actionName) throw new Error('Recorded semantic action is missing');
      if (actionName==='document.saveAs') {
        if (expect.file) throw new Error('Multiple saves in one semantic batch need separate file postconditions; review manually');
        if (typeof actionArgs.path!=='string') throw new Error('Saved filename is missing');
        const filename=basename(actionArgs.path.replaceAll('\\','/'));
        if (!filename || filename==='.' || filename==='..') throw new Error('Saved filename is invalid');
        if (outputs.has(filename.toLowerCase())) throw new Error(`Recorded outputs collide after export: ${filename}`);
        outputs.add(filename.toLowerCase());
        actionArgs.path=`{{runDir}}/${filename}`;
        expect.file={path:filename,minBytes:1};
      }
      return {action:actionName,args:actionArgs};
    });
    steps.push({id:`step-${String(steps.length+1).padStart(3,'0')}`,profile,
      ...(translated.length===1?{action:translated[0]}:{actions:translated}),before:{profileAvailable:profile},expect});
  }
  if (!steps.length) throw new Error('Recording contains no confirmed semantic steps');
  const recipe:ReplayRecipe={schemaVersion:1,name:'Draft from Agent recording',
    target:{titleContains:targetTitle},steps};
  await mkdir(outputDirectory,{recursive:false});
  await writeFile(join(outputDirectory,'manifest.json'),JSON.stringify({schemaVersion:1,name:recipe.name,
    target:recipe.target},null,2)+'\n',{flag:'wx'});
  await writeFile(join(outputDirectory,'steps.json'),JSON.stringify(steps,null,2)+'\n',{flag:'wx'});
  await writeFile(join(outputDirectory,'DRAFT-NOTES.md'),
    '# Review before sharing\n\nThis is an unverified draft. Check the target selector, application/profile compatibility, document baseline, all action parameters, and every postcondition. Replace profile-only checks and file-size-only checks with content-level verification. Run `replay validate` and review the package before export.\n',{flag:'wx'});
  return steps.length;
}
