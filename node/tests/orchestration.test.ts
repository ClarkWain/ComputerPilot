import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerOrchestration, orchestrationStatus, reconcileOrchestration, repairOrchestrationTail, resumeOrchestration,
  startOrchestration } from '../src/orchestration/runner.js';
import type { OrchestrationHost } from '../src/orchestration/types.js';

async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(),'dp-orchestration-'));
  const scriptPath = join(root,'workflow.mjs');
  await writeFile(scriptPath,script);
  return { root, scriptPath, run:join(root,'run'), cleanup:()=>rm(root,{recursive:true,force:true}) };
}

test('dynamic items, branching, question and resume reuse committed command results',async()=>{
  const f=await fixture(`export default async ctx => {
    const input=await ctx.readInput('batch');
    for(const item of input.items) await ctx.item(item.id,async scoped=>{
      if(item.ask) { const answer=await scoped.ask('choice',{question:'Continue?',choices:['yes','no']});
        if(answer==='no') return; }
      await scoped.withDesktop('editor',async desktop=>{
        const state=await desktop.observe('inspect',{target:{titleContains:'Editor'}});
        if(state.enabled) await desktop.step('write',{target:{titleContains:'Editor'},profile:'test',
          actions:[{action:'write',args:{id:item.id}}],before:{titleContains:'Editor'},expect:{titleContains:'Editor'}});
      });
      await scoped.checkpoint('done');
    });
  }`);
  const calls:string[]=[];
  const host:OrchestrationHost={async execute(request){
    calls.push(`${request.scope}/${request.id}`);
    return request.kind==='observe'?{enabled:true}:{written:true};
  }};
  try {
    const first=await startOrchestration('dynamic test',f.scriptPath,
      {items:[{id:'first'},{id:'second',ask:true}]},f.run,host);
    assert.equal(first.status,'waiting_decision');
    assert.equal(first.pending?.kind,'ask');
    assert.deepEqual(calls,['root/item:first/desktop:editor/inspect','root/item:first/desktop:editor/write']);
    await assert.rejects(resumeOrchestration(f.run,host),/decision|reconciliation/i);
    await assert.rejects(answerOrchestration(f.run,'maybe'),/recorded choices/i);
    await answerOrchestration(f.run,'yes');
    const second=await resumeOrchestration(f.run,host);
    assert.equal(second.status,'completed');
    assert.equal(second.committedCount,8);
    const events=(await readFile(join(f.run,'execution.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(events.find(event=>event.kind==='command_commit'&&event.key==='root/item:first/done')?.value,null);
    assert.deepEqual(calls,[
      'root/item:first/desktop:editor/inspect','root/item:first/desktop:editor/write',
      'root/item:second/desktop:editor/inspect','root/item:second/desktop:editor/write']);
    assert.equal((await orchestrationStatus(f.run)).status,'completed');
  } finally {await f.cleanup();}
});

test('checkpoint preserves an explicit JSON value in the durable journal',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.checkpoint('artifact',{id:'one',path:'out/a.png'}); }`);
  const host:OrchestrationHost={async execute(){throw new Error('unexpected host call');}};
  try {
    assert.equal((await startOrchestration('checkpoint value',f.scriptPath,{},f.run,host)).status,'completed');
    const events=(await readFile(join(f.run,'execution.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(events.find(event=>event.kind==='command_commit')?.value,{id:'one',path:'out/a.png'});
  } finally {await f.cleanup();}
});

test('an unexpected worker exit leaves a committed prefix resumable',async()=>{
  const f=await fixture(`export default async ctx => {
    await ctx.checkpoint('first',{done:true});
    if(process.env.DP_TEST_ORCHESTRATION_CRASH==='1') process.exit(9);
    await ctx.checkpoint('second');
  }`);
  const host:OrchestrationHost={async execute(){throw new Error('unexpected host call');}};
  const original=process.env.DP_TEST_ORCHESTRATION_CRASH;
  try {
    process.env.DP_TEST_ORCHESTRATION_CRASH='1';
    const interrupted=await startOrchestration('crash recovery',f.scriptPath,{},f.run,host);
    assert.equal(interrupted.status,'running');
    assert.equal(interrupted.committedCount,1);
    delete process.env.DP_TEST_ORCHESTRATION_CRASH;
    const resumed=await resumeOrchestration(f.run,host);
    assert.equal(resumed.status,'completed');
    assert.equal(resumed.committedCount,2);
  } finally {
    if(original===undefined) delete process.env.DP_TEST_ORCHESTRATION_CRASH;
    else process.env.DP_TEST_ORCHESTRATION_CRASH=original;
    await f.cleanup();
  }
});

test('uncertain desktop step blocks replay until explicit reconciliation',async()=>{
  const f=await fixture(`export default async ctx => {
    await ctx.withDesktop('editor',async desktop=>{
      await desktop.step('save',{target:{titleContains:'Editor'},profile:'test',
        actions:[{action:'save',args:{}}],before:{titleContains:'Editor'},expect:{titleContains:'Editor'}});
    });
    await ctx.checkpoint('complete');
  }`);
  let dispatches=0;
  const host:OrchestrationHost={async execute(){dispatches++;throw new Error('response lost after dispatch');}};
  try {
    const first=await startOrchestration('unknown test',f.scriptPath,{},f.run,host);
    assert.equal(first.status,'needs_reconciliation');
    assert.equal(dispatches,1);
    await assert.rejects(resumeOrchestration(f.run,host),/reconciliation/i);
    assert.equal(dispatches,1);
    await assert.rejects(reconcileOrchestration(f.run,'wrong',{},'checked'),/current uncertain command/i);
    await reconcileOrchestration(f.run,first.pending!.key,{saved:true},'Verified the target document');
    const done=await resumeOrchestration(f.run,host);
    assert.equal(done.status,'completed');
    assert.equal(dispatches,1);
  } finally {await f.cleanup();}
});

test('script drift rejects resume before any new command',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.ask('choice',{question:'Choose',choices:['a','b']}); }`);
  const host:OrchestrationHost={async execute(){throw new Error('unexpected host call');}};
  try {
    const first=await startOrchestration('drift test',f.scriptPath,{},f.run,host);
    assert.equal(first.status,'waiting_decision');
    await answerOrchestration(f.run,'a');
    const journal=await readFile(join(f.run,'execution.jsonl'));
    await writeFile(f.scriptPath,`export default async ctx => { await ctx.checkpoint('changed'); }`);
    await assert.rejects(resumeOrchestration(f.run,host),/script changed/i);
    assert.deepEqual(await readFile(join(f.run,'execution.jsonl')),journal);
  } finally {await f.cleanup();}
});

test('dependency drift that changes a recorded command is reported as a failure',async()=>{
  const f=await fixture(`import { value } from './helper.mjs';
    export default async ctx => { await ctx.checkpoint('version',value);
      await ctx.ask('choice',{question:'Choose',choices:['a','b']}); }`);
  const helper=join(f.root,'helper.mjs');
  const host:OrchestrationHost={async execute(){throw new Error('unexpected host call');}};
  try {
    await writeFile(helper,"export const value='old';\n");
    assert.equal((await startOrchestration('dependency drift',f.scriptPath,{},f.run,host)).status,'waiting_decision');
    await answerOrchestration(f.run,'a');
    await writeFile(helper,"export const value='new';\n");
    const result=await resumeOrchestration(f.run,host);
    assert.equal(result.status,'failed');
    assert.match(result.message??'',/history diverged/i);
  } finally {await f.cleanup();}
});

test('pause takes effect between commands and resume does not redispatch committed work',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.withDesktop('editor',async desktop=>{
    for(const id of ['first','second']) await desktop.step(id,{target:{titleContains:'Editor'},
      profile:'test',actions:[{action:'write',args:{id}}],before:{titleContains:'Editor'},expect:{titleContains:'Editor'}});
  }); }`);
  const calls:string[]=[];
  const host:OrchestrationHost={async execute(request){
    calls.push(request.id);
    if(request.id==='first')await writeFile(join(f.run,'control.json'),JSON.stringify({request:'pause'}));
    return {done:true};
  }};
  try {
    const paused=await startOrchestration('pause test',f.scriptPath,{},f.run,host);
    assert.equal(paused.status,'paused');assert.deepEqual(calls,['first']);
    const done=await resumeOrchestration(f.run,host);
    assert.equal(done.status,'completed');assert.deepEqual(calls,['first','second']);
  } finally {await f.cleanup();}
});

test('a failed read-only observation is safely retried on resume',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.withDesktop('editor',async desktop=>{
    const state=await desktop.observe('inspect',{target:{titleContains:'Editor'}});
    if(state.ready) await desktop.checkpoint('complete');
  }); }`);
  let attempts=0;
  const host:OrchestrationHost={async execute(){
    attempts++;if(attempts===1)throw new Error('temporary observation failure');return {ready:true};
  }};
  try {
    const first=await startOrchestration('read retry',f.scriptPath,{},f.run,host);
    assert.equal(first.status,'needs_reconciliation');
    const done=await resumeOrchestration(f.run,host);
    assert.equal(done.status,'completed');assert.equal(attempts,2);
  } finally {await f.cleanup();}
});

test('cancel is terminal and prevents the next desktop command',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.withDesktop('editor',async desktop=>{
    for(const id of ['first','second']) await desktop.step(id,{target:{titleContains:'Editor'},
      profile:'test',actions:[{action:'write',args:{id}}],before:{titleContains:'Editor'},expect:{titleContains:'Editor'}});
  }); }`);
  const calls:string[]=[];
  const host:OrchestrationHost={async execute(request){
    calls.push(request.id);
    if(request.id==='first')await writeFile(join(f.run,'control.json'),JSON.stringify({request:'cancel'}));
    return {done:true};
  }};
  try {
    const stopped=await startOrchestration('cancel test',f.scriptPath,{},f.run,host);
    assert.equal(stopped.status,'cancelled');assert.deepEqual(calls,['first']);
    await assert.rejects(resumeOrchestration(f.run,host),/terminal/i);
    assert.deepEqual(calls,['first']);
  } finally {await f.cleanup();}
});

test('an incomplete journal tail requires explicit backed-up repair',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.checkpoint('done'); }`);
  const host:OrchestrationHost={async execute(){throw new Error('unexpected host call');}};
  try {
    assert.equal((await startOrchestration('tail test',f.scriptPath,{},f.run,host)).status,'completed');
    await appendFile(join(f.run,'execution.jsonl'),'{"seq":');
    assert.equal((await orchestrationStatus(f.run)).status,'needs_reconciliation');
    await assert.rejects(resumeOrchestration(f.run,host),/incomplete/i);
    const repaired=await repairOrchestrationTail(f.run,'Inspected interrupted write');
    assert.equal(repaired.status,'completed');
    const backup=(await readdir(f.run)).find(name=>name.startsWith('journal-incomplete-'));
    assert.ok(backup);
    assert.equal((await readFile(join(f.run,backup),'utf8')),'{"seq":');
  } finally {await f.cleanup();}
});

test('resume rejects a run directory replaced by a junction',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.checkpoint('done'); }`);
  const host:OrchestrationHost={async execute(){throw new Error('unexpected host call');}};
  let linked=false;
  try {
    assert.equal((await startOrchestration('junction test',f.scriptPath,{},f.run,host)).status,'completed');
    const moved=join(f.root,'moved-run');
    await rename(f.run,moved);
    await symlink(moved,f.run,'junction');
    linked=true;
    await assert.rejects(orchestrationStatus(f.run),/link or non-directory/i);
    await assert.rejects(resumeOrchestration(f.run,host),/link or non-directory/i);
  } finally {
    if(linked) await unlink(f.run);
    await f.cleanup();
  }
});

test('an active pending step is reported as running and rejects a second writer',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.withDesktop('editor',async desktop=>
    desktop.step('save',{target:{titleContains:'Editor'},profile:'test',
      actions:[{action:'save',args:{}}],before:{titleContains:'Editor'},expect:{titleContains:'Editor'}})); }`);
  let entered!:()=>void,finish!:()=>void;
  const dispatched=new Promise<void>(resolve=>{entered=resolve;});
  const release=new Promise<void>(resolve=>{finish=resolve;});
  const host:OrchestrationHost={async execute(){entered();await release;return {saved:true};}};
  try {
    const running=startOrchestration('active test',f.scriptPath,{},f.run,host);
    await dispatched;
    assert.equal((await orchestrationStatus(f.run)).status,'running');
    await assert.rejects(resumeOrchestration(f.run,host),/active|lock|busy/i);
    finish();
    assert.equal((await running).status,'completed');
  } finally {finish?.();await f.cleanup();}
});

test('parallel script commands never dispatch a second desktop write',async()=>{
  const f=await fixture(`export default async ctx => { await ctx.withDesktop('editor',async desktop=>
    Promise.all(['one','two'].map(id=>desktop.step(id,{target:{titleContains:'Editor'},
      profile:'test',actions:[{action:'write',args:{id}}],before:{titleContains:'Editor'},expect:{titleContains:'Editor'}})))); }`);
  let dispatches=0;
  const host:OrchestrationHost={async execute(){dispatches++;return {done:true};}};
  try {
    const report=await startOrchestration('parallel test',f.scriptPath,{},f.run,host);
    assert.equal(report.status,'failed');assert.equal(dispatches,1);
    assert.match(report.message??'',/one at a time/i);
  } finally {await f.cleanup();}
});
