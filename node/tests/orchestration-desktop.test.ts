import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopOrchestrationHost } from '../src/orchestration/desktop-host.js';
import { resumeOrchestration, startOrchestration } from '../src/orchestration/runner.js';
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
