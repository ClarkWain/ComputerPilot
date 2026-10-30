import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopOrchestrationHost } from '../src/orchestration/desktop-host.js';
import { orchestrationStatus, resumeOrchestration, startOrchestration } from '../src/orchestration/runner.js';
import { CommandNotDispatchedError } from '../src/orchestration/types.js';
import type { ReplayApi } from '../src/replay/runner.js';

test('desktop host binds each target and verifies a semantic action before reporting success',async()=>{
  const calls:string[]=[];
  let written=false,leases=0;
  const api:ReplayApi={async call(tool,args){
    calls.push(tool);
    if(tool==='list_windows')return {status:'ok',windows:[
      {window_id:'a',title:'Editor A',pid:1},{window_id:'b',title:'Editor B',pid:2}]};
    if(tool==='get_window_state')return {status:'ok',title:args.window_id==='a'?'Editor A':'Editor B',
      controls:[{name:'Text',role:'Edit',value:written?'done':'ready',control_id:'stale-ref'}],
      semantic:{profiles:[{id:'test'}]}};
    if(tool==='execute_semantic') {assert.equal(args.window_id,'b');written=true;return {status:'ok',completed:1};}
    throw new Error(`Unexpected tool ${tool}`);
  }};
  const host=createDesktopOrchestrationHost(api,'unused','unused',async()=>{
    leases++;return async()=>{leases--;};
  });
  const observed=await host.execute({kind:'observe',scope:'root/desktop:editor',id:'inspect',
    args:{target:{titleContains:'Editor A'}}}) as {controls:Array<Record<string,unknown>>};
  assert.equal('control_id' in observed.controls[0],false);
  const result=await host.execute({kind:'step',scope:'root/desktop:editor',id:'write',args:{
    target:{titleContains:'Editor B'},profile:'test',actions:[{action:'write',args:{text:'done'}}],
    before:{control:{name:'Text',value:'ready'}},expect:{control:{name:'Text',value:'done'}}
  }}) as {status:string;verification:string};
  assert.equal(result.status,'verified');assert.equal(result.verification,'control_checked');
  assert.equal(leases,1);
  await host.releaseDesktop?.();assert.equal(leases,0);
  assert.equal(calls.filter(call=>call==='execute_semantic').length,1);
});

test('desktop host refuses a step without a real postcondition before dispatch',async()=>{
  let dispatched=0;
  const api:ReplayApi={async call(tool){
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'a',title:'Editor'}]};
    if(tool==='execute_semantic'){dispatched++;return {status:'ok',completed:1};}
    return {status:'ok',title:'Editor',semantic:{profiles:[{id:'test'}]},controls:[]};
  }};
  const host=createDesktopOrchestrationHost(api,'unused','unused',async()=>async()=>{});
  try {await assert.rejects(host.execute({kind:'step',scope:'root/desktop:editor',id:'bad',args:{
    target:{titleContains:'Editor'},profile:'test',actions:[{action:'write',args:{}}],
    before:{titleContains:'Editor'},expect:{}
  }}),/observable condition/i);assert.equal(dispatched,0);}
  finally {await host.releaseDesktop?.();}
});

test('batch step resolves a fresh control selector without persisting control ids',async()=>{
  let value='old',dispatched=0;
  const api:ReplayApi={async call(tool,args){
    if(tool==='list_windows')return {status:'ok',windows:[{window_id:'app',title:'Form'}]};
    if(tool==='get_window_state')return {status:'ok',title:'Form',controls:[
      {control_id:'live-123',name:'Name',role:'Edit',value,enabled:true}]};
    if(tool==='execute_batch') {
      dispatched++;assert.deepEqual(args.actions,[{type:'fill_text',control_id:'live-123',text:'new'}]);
      value='new';return {status:'ok',completed:1};
    }
    throw new Error(`Unexpected ${tool}`);
  }};
  const host=createDesktopOrchestrationHost(api,'unused','unused',async()=>async()=>{});
  try {
    const result=await host.execute({kind:'step',scope:'root/desktop:form',id:'fill',args:{
      mode:'batch',target:{titleContains:'Form'},actions:[
        {type:'fill_text',control:{name:'Name',role:'Edit'},text:'new'}],
      before:{control:{name:'Name',value:'old'}},expect:{control:{name:'Name',value:'new'}}
    }}) as {status:string};
    assert.equal(result.status,'verified');assert.equal(dispatched,1);
  } finally {await host.releaseDesktop?.();}
});

test('one authored run can read one application and fill another without redispatch on resume',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dp-cross-app-'));
  const script=join(root,'workflow.mjs'),run=join(root,'run');
  await writeFile(script,`export default async ctx => {
    const source=await ctx.withDesktop('source',async desktop =>
      desktop.observe('read',{target:{titleContains:'Source App'}}));
    const text=source.controls.find(control=>control.name==='Message').value;
    await ctx.withDesktop('target',async desktop => desktop.step('fill',{
      mode:'batch',target:{titleContains:'Target App'},
      actions:[{type:'fill_text',control:{name:'Message',role:'Edit'},text}],
      before:{control:{name:'Message',value:''}},
      expect:{control:{name:'Message',value:text}}
    }));
  }`);
  let targetValue='',dispatches=0,leases=0;
  const api:ReplayApi={async call(tool,args){
    if(tool==='list_windows')return {status:'ok',windows:[
      {window_id:'source',title:'Source App'},{window_id:'target',title:'Target App'}]};
    if(tool==='get_window_state')return {status:'ok',title:args.window_id==='source'?'Source App':'Target App',
      controls:[{control_id:'current',name:'Message',role:'Edit',value:args.window_id==='source'?'Hello':targetValue}]};
    if(tool==='execute_batch') {dispatches++;targetValue='Hello';return {status:'ok',completed:1};}
    throw new Error(`Unexpected ${tool}`);
  }};
  const host=createDesktopOrchestrationHost(api,run,run,async()=>{
    leases++;return async()=>{leases--;};
  });
  try {
    const first=await startOrchestration('cross app',script,{},run,host);
    assert.equal(first.status,'completed',first.message??'cross-app run failed');
    assert.equal(targetValue,'Hello');assert.equal(dispatches,1);
    assert.equal(leases,0);
    const second=await resumeOrchestration(run,host);
    assert.equal(second.status,'completed');assert.equal(dispatches,1);
  } finally {await rm(root,{recursive:true,force:true});}
});

for (const failure of ['precondition','target','profile','control']) {
  test(`explicit resume retries a ${failure} rejection without redispatching its committed prefix`,async()=>{
    const root=await mkdtemp(join(tmpdir(),'dp-before-dispatch-'));
    const script=join(root,'workflow.mjs'),run=join(root,'run');
    const semantic=failure==='profile';
    await writeFile(script,`export default async ctx => ctx.withDesktop('form',async desktop => {
      await desktop.step('prefix',{mode:'batch',target:{titleContains:'Prefix'},
        actions:[{type:'press_keys',chord:'CTRL+S'}],before:{titleContains:'Prefix'},expect:{titleContains:'Prefix'}});
      await desktop.step('fill',{
        ${semantic ? "profile:'test',actions:[{action:'write',args:{text:'Hello'}}]" :
          "mode:'batch',actions:[{type:'fill_text',control:{name:'Message',role:'Edit'},text:'Hello'}]"},
        target:{titleContains:'Form'},
        before:${failure==='precondition' ? "{control:{name:'Message',value:''}}" : "{titleContains:'Form'}"},
        expect:{control:{name:'Message',value:'Hello'}}});
    });`);
    let corrected=false,value='',prefixDispatches=0,fillDispatches=0;
    const api:ReplayApi={async call(tool,args){
      if(tool==='list_windows')return {status:'ok',windows:[
        {window_id:'prefix',title:'Prefix'},{window_id:'form',title:'Form'},
        ...(!corrected&&failure==='target'?[{window_id:'duplicate',title:'Form'}]:[])]};
      if(tool==='get_window_state')return {status:'ok',title:args.window_id==='prefix'?'Prefix':'Form',
        semantic:{profiles:!corrected&&failure==='profile'?[]:[{id:'test'}]},controls:[
          {control_id:'live',name:'Message',role:'Edit',value:!corrected&&failure==='precondition'?'existing':value},
          ...(!corrected&&failure==='control'?[{control_id:'duplicate',name:'Message',role:'Edit',value}]:[])]};
      if(tool==='execute_batch'||tool==='execute_semantic') {
        if(args.window_id==='prefix')prefixDispatches++;else {fillDispatches++;value='Hello';}
        return {status:'ok',completed:1};
      }
      throw new Error(`Unexpected ${tool}`);
    }};
    const host=createDesktopOrchestrationHost(api,run,run,async()=>async()=>{});
    try {
      const first=await startOrchestration('pre-dispatch recovery',script,{},run,host);
      assert.equal(first.status,'retry_available',first.message??'');
      assert.equal(first.pending?.dispatch,'not_dispatched');
      assert.equal(first.committedCount,1);
      assert.equal(prefixDispatches,1);assert.equal(fillDispatches,0);
      assert.equal((await orchestrationStatus(run)).status,'retry_available');
      corrected=true;
      const resumed=await resumeOrchestration(run,host);
      assert.equal(resumed.status,'completed',resumed.message??'');
      assert.equal(prefixDispatches,1);assert.equal(fillDispatches,1);
      assert.equal((await resumeOrchestration(run,host)).status,'completed');
      assert.equal(fillDispatches,1);
    } finally {await rm(root,{recursive:true,force:true});}
  });
}

for (const failure of ['response_lost','partial','postcondition','typed_error']) {
  test(`a ${failure} failure after dispatch still requires reconciliation`,async()=>{
    const root=await mkdtemp(join(tmpdir(),'dp-after-dispatch-'));
    const script=join(root,'workflow.mjs'),run=join(root,'run');
    await writeFile(script,`export default async ctx => ctx.withDesktop('form',desktop => desktop.step('fill',{
      mode:'batch',target:{titleContains:'Form'},actions:[{type:'type_text',text:'Hello'}],
      before:{titleContains:'Form'},expect:{control:{name:'Message',value:'Hello'}},timeoutMs:1}));`);
    let dispatches=0;
    const api:ReplayApi={async call(tool){
      if(tool==='list_windows')return {status:'ok',windows:[{window_id:'form',title:'Form'}]};
      if(tool==='get_window_state')return {status:'ok',title:'Form',controls:[{name:'Message',value:''}]};
      if(tool==='execute_batch') {
        dispatches++;
        if(failure==='response_lost')throw new Error('Response lost after dispatch');
        if(failure==='typed_error')throw new CommandNotDispatchedError('Untrusted backend marker');
        return {status:'ok',completed:failure==='partial'?0:1};
      }
      throw new Error(`Unexpected ${tool}`);
    }};
    const host=createDesktopOrchestrationHost(api,run,run,async()=>async()=>{});
    try {
      const first=await startOrchestration('post-dispatch protection',script,{},run,host);
      assert.equal(first.status,'needs_reconciliation',first.message??'');
      assert.equal(first.pending?.dispatch,undefined);assert.equal(dispatches,1);
      await assert.rejects(resumeOrchestration(run,host),/reconciliation/i);
      assert.equal(dispatches,1);
    } finally {await rm(root,{recursive:true,force:true});}
  });
}

test('missing or incomplete not-dispatched evidence retains legacy crash protection',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dp-dispatch-evidence-'));
  const script=join(root,'workflow.mjs'),run=join(root,'run');
  await writeFile(script,`export default async ctx => ctx.withDesktop('form',desktop => desktop.step('fill',{
    mode:'batch',target:{titleContains:'Form'},actions:[{type:'type_text',text:'Hello'}],
    before:{titleContains:'Form'},expect:{titleContains:'Form'}}));`);
  const host=createDesktopOrchestrationHost({async call(){return {status:'ok',windows:[]};}},
    run,run,async()=>async()=>{});
  try {
    assert.equal((await startOrchestration('dispatch evidence',script,{},run,host)).status,'retry_available');
    const path=join(run,'execution.jsonl');
    const events=(await readFile(path,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const safeHash=events.at(-1).requestHash;
    events.at(-1).requestHash='0'.repeat(64);
    await writeFile(path,events.map(event=>JSON.stringify(event)+'\n').join(''));
    await assert.rejects(orchestrationStatus(run),/dispatch evidence/i);
    events.at(-1).requestHash=safeHash;
    delete events.at(-1).dispatch;delete events.at(-1).requestHash;
    await writeFile(path,events.map(event=>JSON.stringify(event)+'\n').join(''));
    assert.equal((await orchestrationStatus(run)).status,'needs_reconciliation');
    await assert.rejects(resumeOrchestration(run,host),/reconciliation/i);
    events.pop(); // Crash after the intent, before persisting the safe error.
    await writeFile(path,events.map(event=>JSON.stringify(event)+'\n').join(''));
    assert.equal((await orchestrationStatus(run)).status,'needs_reconciliation');
    await assert.rejects(resumeOrchestration(run,host),/reconciliation/i);
  } finally {await rm(root,{recursive:true,force:true});}
});
