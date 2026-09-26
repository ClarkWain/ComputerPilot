import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startWorkflow, resumeWorkflow, reconcileWorkflow } from '../src/workflow/runtime.js';
import type { WorkflowAdapter, WorkflowConfig } from '../src/workflow/types.js';

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'dp-workflow-runtime-'));
  const input=join(root,'input');await mkdir(input);await writeFile(join(input,'one.aseprite'),'source');
  const config:WorkflowConfig={schemaVersion:1,name:'runtime test',inputDirectory:input,
    adapter:'aseprite-png',executable:process.execPath,onError:'continue'};
  return {root,input,config,run:join(root,'run'),async cleanup(){await rm(root,{recursive:true,force:true});}};
}

function adapter(calls:string[]):WorkflowAdapter {
  return {id:'aseprite-png',version:'aseprite-png-v1',
    async probe(source){return {status:'supported',expected:{bytes:await readFile(source.absolutePath,'utf8')}};},
    async execute(source,destination){calls.push(source);await writeFile(destination,await readFile(source));return {status:'completed'};},
    async verify(path,expected){const actual=await readFile(path,'utf8');return {status:actual===expected.bytes?'verified':'failed',
      verifier:'test-bytes',expected};}};
}

test('completed workflow reuse validates artifacts without dispatching again',async()=>{
  const f=await fixture();
  try {
    const calls:string[]=[];const a=adapter(calls);
    const first=await startWorkflow(f.config,a,f.run);
    const second=await resumeWorkflow(a,f.run);
    assert.equal(first.status,'completed');assert.equal(second.status,'completed');assert.equal(calls.length,1);
  } finally {await f.cleanup();}
});

test('unknown export cannot accept an unrelated file at the final artifact path',async()=>{
  const f=await fixture();
  try {
    const unknown:WorkflowAdapter={...adapter([]),async execute(){return {status:'unknown',dispatch:'possibly_partial',code:'lost',message:'producer exited unexpectedly'};}};
    const result=await startWorkflow(f.config,unknown,f.run);
    const item=result.items[0];
    await writeFile(join(f.run,'artifacts','one.png'),'unrelated same-shape file');
    await assert.rejects(reconcileWorkflow(f.run,item.itemId,{action:'accept',reason:'inspect output'},adapter([])),
      /candidate|intent|match|artifact/i);
  } finally {await f.cleanup();}
});

test('caller abort reaches an in-flight adapter and prevents resume redispatch',async()=>{
  const f=await fixture();
  try {
    let started!:()=>void;const executionStarted=new Promise<void>(resolve=>{started=resolve;});
    const calls:string[]=[];
    const a:WorkflowAdapter={...adapter([]),async execute(source,_destination,signal){
      calls.push(source);started();
      if(!signal)throw new Error('adapter did not receive AbortSignal');
      if(signal.aborted)return {status:'unknown',dispatch:'possibly_partial',code:'aborted',message:'cancelled during execution'};
      return await new Promise(resolve=>signal.addEventListener('abort',()=>resolve(
        {status:'unknown',dispatch:'possibly_partial',code:'aborted',message:'cancelled during execution'}),{once:true}));
    }};
    const controller=new AbortController();
    const running=startWorkflow(f.config,a,f.run,{signal:controller.signal});
    await executionStarted;controller.abort();
    const result=await running;
    assert.equal(result.status,'needs_reconciliation');assert.equal(calls.length,1);
    await assert.rejects(resumeWorkflow(a,f.run),/reconcil|cancelled during execution/i);
    assert.equal(calls.length,1);
  } finally {await f.cleanup();}
});

test('an explicit trusted-script skip is a successful workflow outcome',async()=>{
  const f=await fixture();
  try {
    const a:WorkflowAdapter={...adapter([]),async execute(){throw new Error('skip must not execute');}};
    const result=await startWorkflow(f.config,a,f.run,{trustedScript:{hash:'a'.repeat(64),
      async decideItem(){return {decision:'skip',reason:'not needed for this batch'};}}});
    assert.equal(result.status,'completed');assert.equal(result.counts.skipped,1);
  } finally {await f.cleanup();}
});

test('resume rejects executable drift and changed sources for already completed items',async()=>{
  const f=await fixture();
  try {
    const executable=join(f.root,'fake-adapter.exe');await writeFile(executable,'version one');
    const config={...f.config,executable};const a=adapter([]);
    await startWorkflow(config,a,f.run);
    await writeFile(executable,'version two');
    await assert.rejects(resumeWorkflow(a,f.run),/executable changed/i);

    const f2=await fixture();
    try {
      await startWorkflow(f2.config,adapter([]),f2.run);
      await writeFile(join(f2.input,'one.aseprite'),'changed source');
      const result=await resumeWorkflow(adapter([]),f2.run);
      assert.equal(result.status,'needs_reconciliation');assert.ok(['conflict','needs_reconciliation'].includes(result.items[0].status));
    } finally {await f2.cleanup();}
  } finally {await f.cleanup();}
});

test('recovery rejects an artifacts root replaced by a junction',async()=>{
  const f=await fixture();
  try {
    const a=adapter([]);await startWorkflow(f.config,a,f.run);
    const moved=join(f.run,'artifacts-original');await rename(join(f.run,'artifacts'),moved);
    await symlink(moved,join(f.run,'artifacts'),'junction');
    const result=await resumeWorkflow(a,f.run);
    assert.equal(result.status,'needs_reconciliation');
  } finally {await f.cleanup();}
});

test('resume rejects an input root replaced by a junction',async()=>{
  const f=await fixture();
  try {
    const a=adapter([]);await startWorkflow(f.config,a,f.run);
    const moved=join(f.root,'input-original');await rename(f.input,moved);
    await symlink(moved,f.input,'junction');
    const result=await resumeWorkflow(a,f.run);
    assert.equal(result.status,'needs_reconciliation');
    assert.ok(['conflict','needs_reconciliation'].includes(result.items[0].status));
  } finally {await f.cleanup();}
});

test('resume never follows a source intermediate-directory junction',async()=>{
  const f=await fixture();
  try {
    await rm(join(f.input,'one.aseprite'));
    const nested=join(f.input,'group');await mkdir(nested);await writeFile(join(nested,'one.aseprite'),'source');
    const calls:string[]=[];const a=adapter(calls);
    const paused=await startWorkflow(f.config,a,f.run,{control:{async getRequest(){return 'pause';}}});
    assert.equal(paused.status,'paused');
    const moved=join(f.root,'group-original');await rename(nested,moved);
    const outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'one.aseprite'),'source');
    await symlink(outside,nested,'junction');
    const result=await resumeWorkflow(a,f.run);
    assert.equal(calls.length,0);assert.equal(result.status,'completed_with_errors');
  } finally {await f.cleanup();}
});

test('receipt-completed crash cannot reconcile from a final file after its staging candidate disappears',async()=>{
  const f=await fixture();
  try {
    const runtimeUrl=new URL('../src/workflow/runtime.js',import.meta.url).href;
    const code=`import {startWorkflow} from ${JSON.stringify(runtimeUrl)};
      import {readFile,writeFile} from 'node:fs/promises';
      const a={id:'aseprite-png',version:'aseprite-png-v1',
        probe:async s=>({status:'supported',expected:{bytes:await readFile(s.absolutePath,'utf8')}}),
        execute:async(s,d)=>{await writeFile(d,await readFile(s));return {status:'completed'}},
        verify:async()=>{process.exit(74)}};
      await startWorkflow(${JSON.stringify(f.config)},a,${JSON.stringify(f.run)});`;
    const exitCode=await new Promise<number|null>((resolve,reject)=>{
      const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:'ignore'});
      child.once('error',reject);child.once('close',resolve);
    });
    assert.equal(exitCode,74);
    const journal=(await readFile(join(f.run,'execution.jsonl'),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
    const intent=journal.find((event:{kind:string})=>event.kind==='item_intent');
    await rm(join(f.run,intent.candidateRelativePath),{force:true});
    await writeFile(join(f.run,'artifacts','one.png'),'unrelated final file');
    await assert.rejects(reconcileWorkflow(f.run,intent.itemId,{action:'accept',reason:'verify uncertain export'},adapter([])),
      /candidate|artifact/i);
  } finally {await f.cleanup();}
});
