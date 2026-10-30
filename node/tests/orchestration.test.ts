import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerOrchestration, orchestrationStatus, reconcileOrchestration, repairOrchestrationTail, resumeOrchestration,
  startOrchestration } from '../src/orchestration/runner.js';
import type { OrchestrationHost } from '../src/orchestration/types.js';
import { CommandNotDispatchedError } from '../src/orchestration/types.js';

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
    await assert.rejects(reconcileOrchestration(f.run,first.pending!.key,'yes','checked'),/current uncertain command/i);
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

test('an ordinary error cannot claim not-dispatched recovery through text or fields',async()=>{
  const f=await fixture(`export default async ctx => ctx.withDesktop('editor',desktop =>
    desktop.step('write',{target:{titleContains:'Editor'},profile:'test',
      actions:[{action:'write',args:{}}],before:{titleContains:'Editor'},expect:{titleContains:'Editor'}}));`);
  let calls=0;
  const host:OrchestrationHost={async execute(){
    calls++;throw Object.assign(new Error('not_started; not_dispatched'),{dispatch:'not_dispatched'});
  }};
  try {
    const first=await startOrchestration('untrusted error fields',f.scriptPath,{},f.run,host);
    assert.equal(first.status,'needs_reconciliation');assert.equal(first.pending?.dispatch,undefined);
    await assert.rejects(resumeOrchestration(f.run,host),/reconciliation/i);
    assert.equal(calls,1);
  } finally {await f.cleanup();}
});

for (const kind of ['observe','waitFor'] as const) {
  test(`built-in ${kind} reconciliation rejects malformed snapshots without changing the journal`,async()=>{
    const args={target:{titleContains:'Editor'},...(kind==='waitFor'?
      {expect:{titleContains:'Editor'},timeoutMs:1000}:{})};
    const f=await fixture(`export default async ctx => ctx.withDesktop('editor',desktop =>
      desktop.${kind}('inspect',${JSON.stringify(args)}));`);
    let calls=0;
    const host:OrchestrationHost={desktopResultContract:'desktop-v1',async execute(){
      calls++;throw new Error('Observation response lost');
    }};
    try {
      const first=await startOrchestration('snapshot reconciliation',f.scriptPath,{},f.run,host);
      const journalPath=join(f.run,'execution.jsonl');
      const before=await readFile(journalPath);
      const snapshot={title:'Editor',controls:[{name:'Message',role:'Edit',value:'ready',enabled:true,offscreen:false}]};
      for(const value of [null,{}, {title:42,controls:[]},{title:'Editor'},
        {...snapshot,controls:[{name:'Message',role:42}]},
        {...snapshot,controls:[{name:'Message',role:'Edit',value:null}]},
        {...snapshot,controls:[{name:'Message',role:'Edit',enabled:1}]},
        {...snapshot,controls:[{name:'Message',role:'Edit',offscreen:'false'}]},
        {...snapshot,inspection:[]},{...snapshot,inspection:{status:'unknown'}},
        {...snapshot,inspection:{status:['ok']}},
        {...snapshot,inspection:{status:'ok',truncated:'false'}},
        {...snapshot,inspection:{status:'ok',visited:-1}},
        {...snapshot,inspection:{status:'ok',providerError:{message:'failed'}}},
        {...snapshot,inspection:{status:'ok',metrics:{queryMs:'fast'}}}]) {
        await assert.rejects(reconcileOrchestration(f.run,first.pending!.key,value,'Checked snapshot'),
          /desktop reconciliation result/i);
        assert.deepEqual(await readFile(journalPath),before);
        assert.deepEqual(await orchestrationStatus(f.run),first);
      }
      const value={...snapshot,inspection:{status:'ok',evidenceComplete:true,visited:1,
        metrics:{queryMs:2},extra:'future'},extra:{future:true}};
      await reconcileOrchestration(f.run,first.pending!.key,value,'Checked snapshot');
      const done=await resumeOrchestration(f.run,host);
      assert.equal(done.status,'completed');assert.deepEqual(done.result,value);assert.equal(calls,1);
      const events=(await readFile(journalPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(events.find(event=>event.kind==='command_commit')?.verification,'manual_acceptance');
    } finally {await f.cleanup();}
  });
}

for (const [expect,verification] of [
  [{titleContains:'Editor'},'condition_checked'],
  [{control:{name:'Message',value:'ready'}},'control_checked'],
  [{file:{path:'out.png'}},'file_checked'],
  [{file:{path:'out.png'}},'file_hash_checked'],
  [{file:{path:'out.png',sha256:'a'.repeat(64)}},'file_hash_checked']
] as const) {
  test(`built-in step reconciliation accepts ${verification}${'file' in expect && 'sha256' in expect.file?
    ' for a hash condition':''} and never repeats input`,async()=>{
    const f=await fixture(`export default async ctx => ctx.withDesktop('editor',desktop =>
      desktop.step('save',{target:{titleContains:'Editor'},profile:'test',actions:[{action:'save',args:{}}],
        before:{titleContains:'Editor'},expect:${JSON.stringify(expect)}}));`);
    let calls=0;
    const host:OrchestrationHost={desktopResultContract:'desktop-v1',async execute(){
      calls++;throw new Error('Response lost after input');
    }};
    try {
      const first=await startOrchestration('step reconciliation',f.scriptPath,{},f.run,host);
      const journalPath=join(f.run,'execution.jsonl'),before=await readFile(journalPath);
      const result={status:'verified',title:'Editor',verification};
      for(const value of [null,{}, {saved:true},{...result,status:'ok'},{...result,title:42},
        {...result,verification:'manual_acceptance'},
        {...result,verification:[verification]},
        {...result,verification:verification==='condition_checked'?'control_checked':'condition_checked'}]) {
        await assert.rejects(reconcileOrchestration(f.run,first.pending!.key,value,'Checked saved document'),
          /desktop reconciliation result/i);
        assert.deepEqual(await readFile(journalPath),before);
        assert.deepEqual(await orchestrationStatus(f.run),first);
      }
      await assert.rejects(resumeOrchestration(f.run,host),/reconciliation/i);
      await reconcileOrchestration(f.run,first.pending!.key,result,'Checked saved document');
      // The frozen result contract does not change when a different host is supplied on resume.
      const done=await resumeOrchestration(f.run,{async execute(){throw new Error('No repeated input');}});
      assert.equal(done.status,'completed');assert.deepEqual(done.result,result);assert.equal(calls,1);
      const events=(await readFile(journalPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(events.find(event=>event.kind==='command_commit')?.verification,'manual_acceptance');
    } finally {await f.cleanup();}
  });
}

test('desktop result contract leaves custom Suno command results unrestricted',async()=>{
  const f=await fixture(`export default async ctx => ctx.suno('submit',{
    op:'submit',song:{title:'Song',lyrics:'Lyrics',style:'Pop'},baselineUrls:[]});`);
  let calls=0;
  const host:OrchestrationHost={desktopResultContract:'desktop-v1',async execute(){
    calls++;throw new Error('Submission response lost');
  }};
  try {
    const first=await startOrchestration('custom result',f.scriptPath,{},f.run,host);
    const result={saved:true,trackUrls:['https://example.test/song']};
    await reconcileOrchestration(f.run,first.pending!.key,result,'Checked submission');
    const done=await resumeOrchestration(f.run,host);
    assert.equal(done.status,'completed');assert.deepEqual(done.result,result);assert.equal(calls,1);
  } finally {await f.cleanup();}
});

test('unknown frozen desktop result contracts are rejected without journal changes',async()=>{
  const f=await fixture(`export default async ctx => ctx.checkpoint('done');`);
  const host:OrchestrationHost={async execute(){throw new Error('unexpected host call');}};
  try {
    await startOrchestration('invalid contract',f.scriptPath,{},f.run,host);
    const definitionPath=join(f.run,'definition.json');
    const definition=JSON.parse(await readFile(definitionPath,'utf8'));
    await writeFile(definitionPath,JSON.stringify({...definition,desktopResultContract:'unknown'}));
    const before=await readFile(join(f.run,'execution.jsonl'));
    await assert.rejects(orchestrationStatus(f.run),/definition is invalid/i);
    await assert.rejects(resumeOrchestration(f.run,host),/definition is invalid/i);
    assert.deepEqual(await readFile(join(f.run,'execution.jsonl')),before);
  } finally {await f.cleanup();}
});

for (const interruptedRetry of [false,true]) {
  test(`a not-dispatched retry preserves the exact request${interruptedRetry?' across a retry journal crash':''}`,async()=>{
    const f=await fixture(`import { value } from './helper.mjs';
      export default async ctx => ctx.withDesktop('editor',desktop => desktop.step('write',{
        target:{titleContains:'Editor'},profile:'test',actions:[{action:'write',args:{text:value}}],
        before:{titleContains:'Editor'},expect:{titleContains:'Editor'}}));`);
    const helper=join(f.root,'helper.mjs');
    let calls=0;
    const host:OrchestrationHost={async execute(){calls++;throw new CommandNotDispatchedError('Precondition failed');}};
    try {
      await writeFile(helper,"export const value='old';\n");
      const first=await startOrchestration('retry identity',f.scriptPath,{},f.run,host);
      assert.equal(first.status,'retry_available');
      if(interruptedRetry) {
        const events=(await readFile(join(f.run,'execution.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
        await appendFile(join(f.run,'execution.jsonl'),JSON.stringify({seq:events.length+1,
          time:new Date().toISOString(),kind:'command_retry',key:first.pending!.key,reason:'Explicit resume'})+'\n');
      }
      await writeFile(helper,"export const value='changed';\n");
      const result=await resumeOrchestration(f.run,host);
      assert.equal(result.status,'failed');assert.match(result.message??'',/retry command history diverged/i);
      assert.equal(calls,1);
    } finally {await f.cleanup();}
  });
}

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
