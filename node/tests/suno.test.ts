import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerOrchestration, reconcileOrchestration, resumeOrchestration,
  startOrchestration } from '../src/orchestration/runner.js';
import type { OrchestrationHost } from '../src/orchestration/types.js';
import { validateSunoSong } from '../src/suno/input.js';
import { SunoBrowser } from '../src/suno/browser.js';

const script=fileURLToPath(new URL('../src/suno/workflow.js',import.meta.url));
const song={title:'Night Station',lyrics:'[Verse]\nA train arrives',style:'indie pop, warm piano'};
const url='https://suno.com/song/12345678-1234-1234-1234-123456789abc';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'dp-suno-'));
  return {run:join(root,'run'),cleanup:()=>rm(root,{recursive:true,force:true})};}
function input(){return {...song,profileDirectory:'C:/tmp/suno-test-profile'};}

test('Suno input accepts exactly the three required fields',()=>{
  assert.deepEqual(validateSunoSong(song),song);
  assert.throws(()=>validateSunoSong({...song,model:'v6'}),/only title, lyrics and style/i);
  assert.throws(()=>validateSunoSong({...song,lyrics:'  '}),/nonempty/i);
});

test('manual login reopens a prior headless session as a visible browser',async()=>{
  const f=await fixture();
  const commands:string[][]=[];
  try {
    const browser=new SunoBrowser(join(f.run,'profile'),async(_exe,args)=>{
      commands.push(args.slice(args.indexOf('--json')+1));
      return {success:true,data:{}};
    });
    await browser.openLogin();
    assert.deepEqual(commands,[['close'],['--headed','open','https://suno.com/create']]);
  } finally {await f.cleanup();}
});

test('Suno workflow fills, submits once, verifies generated URLs, and replays without a second submission',async()=>{
  const f=await fixture();
  const calls:string[]=[];
  const host:OrchestrationHost={async execute(request){
    calls.push(request.id);
    if(request.id==='inspect')return {state:'form_ready',trackUrls:[]};
    if(request.id==='prepare')return {status:'prepared'};
    if(request.id==='submit')return {status:'submitted',trackUrls:[url]};
    if(request.id==='wait_1')return {status:'ready',trackUrls:[url]};
    throw new Error(`Unexpected command ${request.id}`);
  }};
  try {
    const first=await startOrchestration('Suno test',script,input(),f.run,host);
    assert.equal(first.status,'completed');
    assert.deepEqual(first.result,{status:'ready',title:song.title,trackUrls:[url]});
    assert.deepEqual(calls,['inspect','prepare','submit','wait_1']);
    const second=await resumeOrchestration(f.run,host);
    assert.equal(second.status,'completed');
    assert.deepEqual(calls,['inspect','prepare','submit','wait_1']);
  } finally {await f.cleanup();}
});

test('Suno login pause resumes after a recorded answer',async()=>{
  const f=await fixture();
  const host:OrchestrationHost={async execute(request){
    if(request.id==='inspect')return {state:'login_required',trackUrls:[]};
    if(request.id==='inspect_after_login')return {state:'form_ready',trackUrls:[]};
    if(request.id==='prepare')return {status:'prepared'};
    if(request.id==='submit')return {status:'submitted',trackUrls:[url]};
    if(request.id==='wait_1')return {status:'ready',trackUrls:[url]};
    throw new Error(`Unexpected ${request.id}`);
  }};
  try {
    const first=await startOrchestration('Suno login',script,input(),f.run,host);
    assert.equal(first.status,'waiting_decision');
    assert.equal(first.pending?.kind,'ask');
    await answerOrchestration(f.run,'ready');
    assert.equal((await resumeOrchestration(f.run,host)).status,'completed');
  } finally {await f.cleanup();}
});

test('interrupted form preparation retries, but uncertain Create never clicks twice',async()=>{
  const f=await fixture();
  let prepare=0,submits=0;
  const host:OrchestrationHost={async execute(request){
    if(request.id==='inspect')return {state:'form_ready',trackUrls:[]};
    if(request.id==='prepare') {prepare++;if(prepare===1)throw new Error('form rerendered');return {status:'prepared'};}
    if(request.id==='submit') {submits++;throw new Error('response lost after Create');}
    if(request.id==='wait_1')return {status:'ready',trackUrls:[url]};
    throw new Error(`Unexpected ${request.id}`);
  }};
  try {
    const first=await startOrchestration('Suno recovery',script,input(),f.run,host);
    assert.equal(first.status,'needs_reconciliation');assert.equal(prepare,1);assert.equal(submits,0);
    const second=await resumeOrchestration(f.run,host);
    assert.equal(second.status,'needs_reconciliation');assert.equal(prepare,2);assert.equal(submits,1);
    await assert.rejects(resumeOrchestration(f.run,host),/reconciliation/i);
    assert.equal(submits,1);
    await reconcileOrchestration(f.run,second.pending!.key,{status:'submitted',trackUrls:[url]},
      'Verified one new Suno song URL in the account');
    const last=await resumeOrchestration(f.run,host);
    assert.equal(last.status,'completed');assert.equal(submits,1);
  } finally {await f.cleanup();}
});

test('slow Suno generation reports submitted_pending without a second Create',async()=>{
  const f=await fixture();let submits=0;
  const host:OrchestrationHost={async execute(request){
    if(request.id==='inspect')return {state:'form_ready',trackUrls:[]};
    if(request.id==='prepare')return {status:'prepared'};
    if(request.id==='submit'){submits++;return {status:'submitted',trackUrls:[url]};}
    if(request.id.startsWith('wait_'))return {status:'pending',trackUrls:[url]};
    throw new Error(`Unexpected ${request.id}`);
  }};
  try {
    const report=await startOrchestration('Suno pending',script,input(),f.run,host);
    assert.equal(report.status,'completed');
    assert.deepEqual(report.result,{status:'submitted_pending',title:song.title,trackUrls:[url]});
    assert.equal(submits,1);
  } finally {await f.cleanup();}
});
