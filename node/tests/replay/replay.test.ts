import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkFile, loadRecipe, type ReplayRecipe } from '../../src/replay/recipe.js';
import { runReplay } from '../../src/replay/runner.js';
import { exportArchive, openArchive } from '../../src/replay/archive.js';
import AdmZip from 'adm-zip';
import { spawnSync } from 'node:child_process';
import { acquireDesktopLock } from '../../src/replay/lock.js';
import { ReplayRecorder } from '../../src/replay/record.js';
import { draftFromRecording } from '../../src/replay/draft.js';
import sharp from 'sharp';
import { inspectRun, recipeHash } from '../../src/replay/recovery.js';
import type { JsonObject } from '../../src/native/client.js';

const recipe:ReplayRecipe={schemaVersion:1,name:'test',target:{titleContains:'Paint'},steps:[
  {id:'first',profile:'paint',action:{action:'drawing.drawEllipse',args:{}},expect:{profileAvailable:'paint'}},
  {id:'second',profile:'paint',action:{action:'drawing.drawEllipse',args:{}},expect:{profileAvailable:'paint'}}
]};

test('a multi-action step dispatches once and commits only after every action completes',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-batch-'));
  const batched:ReplayRecipe={...recipe,steps:[{...recipe.steps[0],action:undefined,
    actions:[recipe.steps[0].action!,recipe.steps[1].action!]}]};
  let dispatches=0;
  const api={async call(tool:string,args:JsonObject):Promise<JsonObject>{
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return {status:'ok',semantic:{profiles:[{id:'paint'}]}};
    if(tool==='execute_semantic'){dispatches++;assert.equal((args.actions as unknown[]).length,2);
      return {status:'ok',completed:2};}
    throw new Error(tool);
  }};
  try {
    await runReplay(api,batched,join(base,'run'));
    assert.equal(dispatches,1);
    assert.equal((await inspectRun(join(base,'run'),batched)).committed,1);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('recipe validation rejects duplicate steps and escaping paths',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dp-recipe-test-'));
  try {
    await writeFile(join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,name:recipe.name,target:recipe.target}));
    await writeFile(join(dir,'steps.json'),JSON.stringify([recipe.steps[0],recipe.steps[0]]));
    await assert.rejects(loadRecipe(dir),/Duplicate step id/);
    await writeFile(join(dir,'steps.json'),JSON.stringify([
      {...recipe.steps[0],expect:{file:{path:'../outside.png'}}}]));
    await assert.rejects(loadRecipe(dir),/relative path/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('single-file export and import preserve a validated recipe',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dp-archive-test-'));
  const source=join(dir,'source');
  try {
    const {mkdir}=await import('node:fs/promises');await mkdir(source);
    await writeFile(join(source,'manifest.json'),JSON.stringify({schemaVersion:1,name:recipe.name,target:recipe.target}));
    await writeFile(join(source,'steps.json'),JSON.stringify(recipe.steps));
    const archive=join(dir,'test.dpreplay');
    await exportArchive(source,archive);
    const opened=await openArchive(archive);
    try { assert.deepEqual(await loadRecipe(opened.directory),recipe); }
    finally { await opened.cleanup(); }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('share export rejects a machine-specific process and absolute action path',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dp-export-portable-'));
  try {
    await writeFile(join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,name:'local',
      target:{titleContains:'Paint',pid:123}}));
    await writeFile(join(dir,'steps.json'),JSON.stringify(recipe.steps));
    await assert.rejects(exportArchive(dir,join(dir,'one.dpreplay')),/process ID/);
    await writeFile(join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,name:'local',target:recipe.target}));
    await writeFile(join(dir,'steps.json'),JSON.stringify([{...recipe.steps[0],
      action:{action:'document.saveAs',args:{path:'C:\\Users\\other\\image.png'}}}]));
    await assert.rejects(exportArchive(dir,join(dir,'two.dpreplay')),/Absolute paths/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('archive import rejects a traversal entry before writing files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dp-archive-unsafe-'));
  try {
    const zip=new AdmZip();
    zip.addFile('manifest.json',Buffer.from(JSON.stringify({schemaVersion:1,name:'unsafe',target:{titleContains:'Paint'}})));
    zip.addFile('steps.json',Buffer.from(JSON.stringify(recipe.steps)));
    zip.addFile('assets/../outside.txt',Buffer.from('outside'));
    const path=join(dir,'unsafe.dpreplay');await writeFile(path,zip.toBuffer());
    await assert.rejects(openArchive(path),/Unsafe or duplicate archive entry/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('export refuses an asset symlink that leaves the recipe directory',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'dp-export-symlink-'));
  const source=join(dir,'recipe');await mkdir(join(source,'assets'),{recursive:true});
  try {
    const outside=join(dir,'outside.txt');await writeFile(outside,'private');
    try { await symlink(outside,join(source,'assets','outside.txt'),'file'); }
    catch(error) { if ((error as NodeJS.ErrnoException).code==='EPERM') {t.skip('Symlinks unavailable');return;} throw error; }
    const {createHash}=await import('node:crypto');
    const sha256=createHash('sha256').update('private').digest('hex');
    await writeFile(join(source,'manifest.json'),JSON.stringify({schemaVersion:1,name:'escape',
      target:recipe.target,assets:[{path:'assets/outside.txt',sha256}]}));
    await writeFile(join(source,'steps.json'),JSON.stringify(recipe.steps));
    await assert.rejects(exportArchive(source,join(dir,'escape.dpreplay')),/escapes recipe directory/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('replay records completed steps and stops after uncertain dispatch without retry',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-test-'));
  const run=join(base,'run');const calls:string[]=[];
  const api={async call(tool:string):Promise<JsonObject>{
    calls.push(tool);
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return {status:'ok',semantic:{profiles:[{id:'paint'}]}};
    if(tool==='execute_semantic')return calls.filter(x=>x==='execute_semantic').length===2
      ?{status:'error',dispatch:'possibly_partial'}:{status:'ok',completed:1};
    throw new Error(tool);
  }};
  try {
    await assert.rejects(runReplay(api,recipe,run),/dispatch outcome requires inspection/);
    assert.equal(calls.filter(x=>x==='execute_semantic').length,2);
    const lines=(await readFile(join(run,'execution.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x) as JsonObject);
    assert.deepEqual(lines.filter(x=>x.kind==='commit').map(x=>x.step),['first']);
    assert.equal(lines.at(-1)?.kind,'stopped');
    const inspection=await inspectRun(run,recipe);
    assert.equal(inspection.state,'needs_reconciliation');
    assert.equal(inspection.verification,'partial');
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('resume continues only a committed prefix after rechecking a document baseline',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-resume-'));
  const run=join(base,'run');let ready=false,dispatched=0;
  const resumable:ReplayRecipe={...recipe,steps:[recipe.steps[0],
    {...recipe.steps[1],before:{control:{name:'Document',value:'baseline'}}}]};
  const api={async call(tool:string):Promise<JsonObject>{
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return {status:'ok',title:'Paint',semantic:{profiles:[{id:'paint'}]},
      controls:[{name:'Document',value:ready?'baseline':'other'}]};
    if(tool==='execute_semantic'){dispatched++;return {status:'ok',completed:1};}
    throw new Error(tool);
  }};
  try {
    await assert.rejects(runReplay(api,resumable,run),/precondition failed/);
    assert.equal(dispatched,1);
    assert.deepEqual(await inspectRun(run,resumable),{state:'resumable',canResume:true,committed:1,nextStep:'second',verification:'partial'});
    await assert.rejects(inspectRun(run,{...resumable,name:'different'}),/another recipe/);
    ready=true;
    const result=await runReplay(api,resumable,run,run,true);
    assert.equal(result.verification,'partial');
    assert.equal(dispatched,2);
    assert.equal((await inspectRun(run,resumable)).state,'complete');
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('replay refuses an unknown dispatch even if status and count claim success',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-unknown-dispatch-'));
  const run=join(base,'run');let dispatches=0;
  const api={async call(tool:string):Promise<JsonObject>{
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return {status:'ok',semantic:{profiles:[{id:'paint'}]}};
    if(tool==='execute_semantic'){dispatches++;return {status:'ok',completed:1,dispatch:'unknown'};}
    throw new Error(tool);
  }};
  try {
    await assert.rejects(runReplay(api,recipe,run),/dispatch outcome was not confirmed/);
    assert.equal(dispatches,1);
    const inspection=await inspectRun(run,recipe);
    assert.equal(inspection.state,'needs_reconciliation');assert.equal(inspection.canResume,false);
    assert.equal(inspection.committed,0);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('concurrent resume rechecks the checkpoint after acquiring the desktop lock',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-resume-race-'));
  const run=join(base,'run');
  const resumable:ReplayRecipe={...recipe,steps:[recipe.steps[0],
    {...recipe.steps[1],before:{control:{name:'Document',value:'baseline'}}}]};
  let lockHeld=false;
  const lockWaiters:Array<()=>void>=[];
  let signalQueued!:()=>void;
  const queued=new Promise<void>(resolveQueued=>{signalQueued=resolveQueued;});
  const acquireTestLock=async():Promise<()=>Promise<void>>=>{
    if(lockHeld){signalQueued();await new Promise<void>(resolveWaiter=>lockWaiters.push(resolveWaiter));}
    lockHeld=true;let released=false;
    return async()=>{
      if(released)return;released=true;
      const next=lockWaiters.shift();if(next)next();else lockHeld=false;
    };
  };
  const state=(value:string):JsonObject=>({status:'ok',title:'Paint',semantic:{profiles:[{id:'paint'}]},
    controls:[{name:'Document',role:'Text',value}]});
  let firstRunStateReads=0,initialDispatches=0;
  const firstRunApi={async call(tool:string):Promise<JsonObject>{
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return state(++firstRunStateReads<3?'baseline':'other');
    if(tool==='execute_semantic'){initialDispatches++;return {status:'ok',completed:1};}
    throw new Error(tool);
  }};
  let started!:()=>void,releaseAction!:()=>void;
  const actionStarted=new Promise<void>(resolveStarted=>{started=resolveStarted;});
  const actionGate=new Promise<void>(resolveAction=>{releaseAction=resolveAction;});
  let resumeDispatches=0;
  const resumeApi={async call(tool:string):Promise<JsonObject>{
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return state('baseline');
    if(tool==='execute_semantic'){
      resumeDispatches++;
      if(resumeDispatches===1){started();await actionGate;}
      return {status:'ok',completed:1};
    }
    throw new Error(tool);
  }};
  try {
    await assert.rejects(runReplay(firstRunApi,resumable,run,run,false,acquireTestLock),/precondition failed/);
    assert.equal(initialDispatches,1);
    assert.deepEqual(await inspectRun(run,resumable),{state:'resumable',canResume:true,committed:1,nextStep:'second',verification:'partial'});

    const firstResume=runReplay(resumeApi,resumable,run,run,true,acquireTestLock);
    await actionStarted;
    const secondResume=runReplay(resumeApi,resumable,run,run,true,acquireTestLock).then(
      ()=>'unexpected success',error=>error instanceof Error?error.message:String(error));
    await queued;
    releaseAction();
    await firstResume;
    const secondResult=await secondResume;
    assert.match(secondResult,/Replay cannot resume/);
    assert.equal(resumeDispatches,1);
    assert.equal((await inspectRun(run,resumable)).state,'complete');
  } finally { releaseAction();await rm(base,{recursive:true,force:true}); }
});

test('inspect distinguishes a committed prefix from permission to resume',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dp-replay-inspect-baseline-'));
  const journal=join(dir,'execution.jsonl');
  const prefix=[{kind:'intent',step:'first'},
    {kind:'receipt',step:'first',result:{status:'ok',completed:1,dispatch:'returned'}},
    {kind:'postcondition',step:'first',passed:true},
    {kind:'commit',step:'first',verification:'profile_compatibility_only'}];
  const writeJournal=async(candidate:ReplayRecipe,events:unknown[])=>writeFile(journal,
    [{kind:'start',recipeHash:recipeHash(candidate)},...events].map(x=>JSON.stringify(x)).join('\n')+'\n');
  let apiCalls=0;
  const api={async call():Promise<JsonObject>{apiCalls++;throw new Error('Resume must stop before observation');}};
  try {
    await writeJournal(recipe,prefix);
    const inspection=await inspectRun(dir,recipe);
    assert.equal(inspection.state,'resumable');assert.equal(inspection.canResume,false);
    assert.equal(inspection.committed,1);assert.equal(inspection.nextStep,'second');
    assert.match(inspection.reason!,/document-specific before condition/);
    const original=await readFile(journal,'utf8');
    await assert.rejects(runReplay(api,recipe,dir,dir,true),/document-specific before condition/);
    assert.equal(apiCalls,0);assert.equal(await readFile(journal,'utf8'),original);
    for (const before of [{profileAvailable:'paint'},{titleContains:'Paint'},{fileAbsent:'new.png'},
      {file:{path:'image.png',minBytes:1}},{capture:{anchor:{nameContains:'Canvas',role:'Pane',
        inset:{x:0,y:0,unit:'pixels' as const}},width:1,height:1,savePath:'stage.png'}}]) {
      const candidate={...recipe,steps:[recipe.steps[0],{...recipe.steps[1],before}]};
      await writeJournal(candidate,prefix);
      assert.equal((await inspectRun(dir,candidate)).canResume,false);
    }
    for (const before of [{control:{name:'Document',value:''}},
      {file:{path:'image.png',sha256:'a'.repeat(64)}},
      {capture:{anchor:{nameContains:'Canvas',role:'Pane',inset:{x:0,y:0,unit:'pixels' as const}},
        width:1,height:1,reference:{asset:'assets/baseline.png',channelTolerance:0,maxChangedPercent:0}}}]) {
      const candidate={...recipe,steps:[recipe.steps[0],{...recipe.steps[1],before}]};
      await writeJournal(candidate,prefix);
      assert.equal((await inspectRun(dir,candidate)).canResume,true);
    }
    const strong={...recipe,steps:[recipe.steps[0],{...recipe.steps[1],before:{control:{name:'Document',value:'baseline'}}}]};
    await writeJournal(strong,[...prefix,{kind:'intent',step:'second'},
      {kind:'receipt',step:'second',result:{status:'ok',completed:1,dispatch:'unknown'}}]);
    assert.equal((await inspectRun(dir,strong)).state,'needs_reconciliation');
    assert.equal((await inspectRun(dir,strong)).canResume,false);
    await writeJournal(strong,[...prefix,{kind:'intent',step:'second'}]);
    assert.equal((await inspectRun(dir,strong)).canResume,false);
    await writeFile(journal,'{"kind":"receipt"', {flag:'a'});
    assert.match((await inspectRun(dir,strong)).reason!,/incomplete event/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('profile-only playback is reported as partial verification',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-partial-'));
  const run=join(base,'run');
  const api={async call(tool:string):Promise<JsonObject>{
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return {status:'ok',semantic:{profiles:[{id:'paint'}]}};
    if(tool==='execute_semantic')return {status:'ok',completed:1};
    throw new Error(tool);
  }};
  try {
    const result=await runReplay(api,{...recipe,steps:[recipe.steps[0]]},run);
    assert.equal(result.verification,'partial');
    const lines=(await readFile(join(run,'execution.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x) as JsonObject);
    assert.deepEqual(lines.at(-1)?.verification,'partial');
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('a failed document precondition sends no input',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-pre-'));
  let dispatched=0;
  const api={async call(tool:string):Promise<JsonObject>{
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return {status:'ok',title:'Paint',controls:[{name:'Document',role:'Edit',value:'other'}],
      semantic:{profiles:[{id:'paint'}]}};
    if(tool==='execute_semantic'){dispatched++;return {status:'ok',completed:1};}
    throw new Error(tool);
  }};
  const step={...recipe.steps[0],before:{control:{name:'Document',role:'Edit',value:'expected'}}};
  try {
    await assert.rejects(runReplay(api,{...recipe,steps:[step]},join(base,'run')),/precondition failed/);
    assert.equal(dispatched,0);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('postcondition waits for an asynchronous control value without redispatch',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-settle-'));
  let observations=0,dispatched=0;
  const api={async call(tool:string):Promise<JsonObject>{
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
    if(tool==='get_window_state')return {status:'ok',title:'Paint',
      controls:[{name:'Status',role:'Text',value:++observations>=3?'Done':'Working'}],
      semantic:{profiles:[{id:'paint'}]}};
    if(tool==='execute_semantic'){dispatched++;return {status:'ok',completed:1};}
    throw new Error(tool);
  }};
  const step={...recipe.steps[0],expect:{control:{name:'Status',role:'Text',value:'Done'}},settleTimeoutMs:1000};
  try {
    await runReplay(api,{...recipe,steps:[step]},join(base,'run'));
    assert.equal(dispatched,1);
    const lines=(await readFile(join(base,'run','execution.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x) as JsonObject);
    assert.equal(lines.find(x=>x.kind==='postcondition')?.polls,2);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('desktop input lock excludes a second Node process and releases cleanly',async()=>{
  const moduleUrl=new URL('../../src/replay/lock.js',import.meta.url).href;
  const base=await mkdtemp(join(tmpdir(),'dp-lock-test-'));
  const lockPath=join(base,'input.lock');
  const script=`import {acquireDesktopLock} from ${JSON.stringify(moduleUrl)}; try { const release=await acquireDesktopLock(${JSON.stringify(lockPath)}); await release(); process.stdout.write('acquired'); } catch { process.stdout.write('busy'); }`;
  const release=await acquireDesktopLock(lockPath);
  try {
    const blocked=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(blocked.status,0);assert.equal(blocked.stdout,'busy');
  } finally { await release(); }
  const after=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(after.status,0);assert.equal(after.stdout,'acquired');
  await rm(base,{recursive:true,force:true});
});

test('stale lock from a crashed owner is recovered before input',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-stale-lock-'));
  const lockPath=join(base,'input.lock');
  const moduleUrl=new URL('../../src/replay/lock.js',import.meta.url).href;
  const script=`import {acquireDesktopLock} from ${JSON.stringify(moduleUrl)}; await acquireDesktopLock(${JSON.stringify(lockPath)}); process.stdout.write('held'); process.exit(0);`;
  try {
    const crashed=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(crashed.status,0);assert.equal(crashed.stdout,'held');
    const release=await acquireDesktopLock(lockPath);
    await release();
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('opt-in Agent semantic recording produces a reviewable portable draft',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-record-'));
  try {
    const recorder=await ReplayRecorder.create(join(base,'journal'));
    recorder.observe('list_windows',{}, {status:'ok',windows:[{window_id:'w1',title:'画图',pid:42}]});
    const id=await recorder.intent('execute_semantic',{window_id:'w1',profile:'paint',
      actions:[{action:'document.saveAs',args:{path:'C:\\Users\\me\\drawing.png',format:'png',overwrite:false}}]});
    await recorder.receipt(id,{status:'ok',completed:1,profile:'paint'});
    const output=join(base,'draft');
    assert.equal(await draftFromRecording(recorder.path,output),1);
    const loaded=await loadRecipe(output);
    assert.equal(loaded.target.titleContains,'画图');
    assert.equal(loaded.steps[0].action!.args.path,'{{runDir}}/drawing.png');
    assert.equal(loaded.steps[0].expect.file?.path,'drawing.png');
    await exportArchive(output,join(base,'draft.dpreplay'));
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('draft preserves confirmed semantic batches as one portable partial step',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-draft-batch-'));
  try {
    const recorder=await ReplayRecorder.create(join(base,'journal'));
    recorder.observe('list_windows',{}, {status:'ok',windows:[{window_id:'w1',title:'Paint'}]});
    const actions=[recipe.steps[0].action!,{action:'document.saveAs',args:{path:'C:\\original\\image.png'}}];
    const id=await recorder.intent('execute_semantic',{window_id:'w1',profile:'paint',actions});
    await recorder.receipt(id,{status:'ok',completed:2,profile:'paint',dispatch:'returned'});
    const output=join(base,'draft');
    assert.equal(await draftFromRecording(recorder.path,output),1);
    const loaded=await loadRecipe(output);
    assert.equal(loaded.steps.length,1);assert.equal(loaded.steps[0].action,undefined);
    assert.deepEqual(loaded.steps[0].actions,[actions[0],{...actions[1],args:{path:'{{runDir}}/image.png'}}]);
    assert.deepEqual(loaded.steps[0].expect.file,{path:'image.png',minBytes:1});
    let dispatches=0;
    const run=join(base,'run');
    const api={async call(tool:string,args:JsonObject):Promise<JsonObject>{
      if(tool==='list_windows')return {status:'ok',windows:[{window_id:'w1',title:'Paint'}]};
      if(tool==='get_window_state')return {status:'ok',semantic:{profiles:[{id:'paint'}]}};
      if(tool==='execute_semantic'){
        dispatches++;assert.equal((args.actions as unknown[]).length,2);
        await writeFile(join(run,'image.png'),'unverified file');return {status:'ok',completed:2};
      }
      throw new Error(tool);
    }};
    assert.equal((await runReplay(api,loaded,run)).verification,'partial');
    assert.equal(dispatches,1);
    assert.deepEqual(await inspectRun(run,loaded),{state:'complete',canResume:false,committed:1,verification:'partial'});

    const maximum=await ReplayRecorder.create(join(base,'max-journal'));
    maximum.observe('list_windows',{}, {status:'ok',windows:[{window_id:'w1',title:'Paint'}]});
    const maximumId=await maximum.intent('execute_semantic',{window_id:'w1',profile:'paint',
      actions:Array.from({length:256},()=>actions[0])});
    await maximum.receipt(maximumId,{status:'ok',completed:256,profile:'paint'});
    const maxOutput=join(base,'max-draft');
    assert.equal(await draftFromRecording(maximum.path,maxOutput),1);
    assert.equal((await loadRecipe(maxOutput)).steps[0].actions?.length,256);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('draft rejects uncertain, basic and multi-save calls before creating output',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-draft-refuse-'));
  const action=recipe.steps[0].action!;
  const save=(path:string)=>({action:'document.saveAs',args:{path}});
  const cases=[
    {actions:[action,action],result:{status:'ok',completed:1,profile:'paint'},message:/fully confirmed/},
    {actions:[action],result:{status:'ok',completed:1,profile:'paint',dispatch:'unknown'},message:/fully confirmed/},
    {actions:[action],result:{status:'partial',completed:1,profile:'paint'},message:/may have changed/},
    {actions:[action],result:{status:'ok',completed:1},message:/profile was not confirmed/},
    {actions:[action],result:{status:'ok',completed:1,profile:'other'},message:/profile was not confirmed/},
    {actions:[],result:{status:'ok',completed:0,profile:'paint'},message:/fully confirmed/},
    {actions:Array.from({length:257},()=>action),result:{status:'ok',completed:257,profile:'paint'},message:/fully confirmed/},
    {tool:'execute_batch',actions:[action],result:{status:'ok',completed:1,profile:'paint'},message:/portable semantic step/},
    {actions:[save('C:\\one\\a.png'),save('C:\\two\\b.png')],result:{status:'ok',completed:2,profile:'paint'},message:/Multiple saves/},
    {actions:[action],result:undefined,message:/outcome is unknown/}
  ];
  try {
    for (const [index,scenario] of cases.entries()) {
      const recorder=await ReplayRecorder.create(join(base,`journal-${index}`));
      recorder.observe('list_windows',{}, {status:'ok',windows:[{window_id:'w1',title:'Paint'}]});
      const id=await recorder.intent(scenario.tool??'execute_semantic',{window_id:'w1',profile:'paint',actions:scenario.actions});
      if(scenario.result)await recorder.receipt(id,scenario.result);
      const output=join(base,`draft-${index}`);
      await assert.rejects(draftFromRecording(recorder.path,output),scenario.message);
      await assert.rejects(stat(output),{code:'ENOENT'});
    }
    const recorder=await ReplayRecorder.create(join(base,'collision'));
    recorder.observe('list_windows',{}, {status:'ok',windows:[{window_id:'w1',title:'Paint'}]});
    for(const path of ['C:\\one\\image.png','C:\\two\\IMAGE.png']) {
      const id=await recorder.intent('execute_semantic',{window_id:'w1',profile:'paint',actions:[action,save(path)]});
      await recorder.receipt(id,{status:'ok',completed:2,profile:'paint'});
    }
    const output=join(base,'collision-draft');
    await assert.rejects(draftFromRecording(recorder.path,output),/outputs collide/);
    await assert.rejects(stat(output),{code:'ENOENT'});
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('draft refuses input whose result may be partial',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dp-replay-uncertain-'));
  try {
    const recorder=await ReplayRecorder.create(base);
    recorder.observe('list_windows',{}, {status:'ok',windows:[{window_id:'w1',title:'Paint'}]});
    const id=await recorder.intent('execute_semantic',{window_id:'w1',profile:'paint',
      actions:[{action:'drawing.drawEllipse',args:{}}]});
    await recorder.receipt(id,{status:'error',dispatch:'possibly_partial'});
    await assert.rejects(draftFromRecording(recorder.path,join(base,'draft')),/may have changed/);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('output image samples detect a wrong saved result',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dp-replay-samples-'));
  try {
    const data=Buffer.from([10,20,30,255, 100,110,120,255]);
    await sharp(data,{raw:{width:2,height:1,channels:4}}).png().toFile(join(dir,'image.png'));
    const expected={path:'image.png',width:2,height:1,
      samples:[{x:1,y:0,rgb:[100,110,120] as [number,number,number],tolerance:0}]};
    await checkFile(dir,expected);
    await assert.rejects(checkFile(dir,{...expected,samples:[{x:1,y:0,rgb:[0,0,0],tolerance:0}]}),
      /Image sample mismatch/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('reference comparison catches damage outside sampled pixels',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dp-replay-reference-'));
  try {
    await mkdir(join(dir,'assets'));
    const expected=Buffer.alloc(2*2*3,255),actual=Buffer.from(expected);
    actual.fill(0,9,12);
    await sharp(expected,{raw:{width:2,height:2,channels:3}}).png().toFile(join(dir,'assets','reference.png'));
    await sharp(actual,{raw:{width:2,height:2,channels:3}}).png().toFile(join(dir,'image.png'));
    const condition={path:'image.png',samples:[{x:0,y:0,rgb:[255,255,255] as [number,number,number]}],
      reference:{asset:'assets/reference.png',channelTolerance:20,maxChangedPercent:0.5}};
    await assert.rejects(checkFile(dir,condition),/Image reference mismatch/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
