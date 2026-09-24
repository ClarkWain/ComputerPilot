import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeClient, NativeCallError } from '../../src/native/client.js';

const worker = String.raw`
const readline=require('node:readline');
const rl=readline.createInterface({input:process.stdin});
const ops=['echo','slow','hang','reject','reject_partial'];
rl.on('line', line=>{
  const q=JSON.parse(line);
  if(q.operation==='native.hello') return process.stdout.write(JSON.stringify({id:q.id,result:{protocolVersion:1,operations:ops,processId:process.pid,preflight:{ready:true}}})+'\n');
  if(q.operation==='hang') return;
  if(q.operation==='reject') return process.stdout.write(JSON.stringify({id:q.id,error:{code:'desktop_environment_not_ready',message:'locked',dispatch:'not_started',preflight:{ready:false},verification:'not_attempted'}})+'\n');
  if(q.operation==='reject_partial') return process.stdout.write(JSON.stringify({id:q.id,error:{code:'platform_operation_failed',message:'input uncertain',dispatch:'possibly_partial'}})+'\n');
  const done=()=>process.stdout.write(JSON.stringify({id:q.id,result:{status:'ok',args:q.args}})+'\n');
  if(q.operation==='slow') setTimeout(done,50); else done();
});`;

test('handshake and serial Unicode JSONL calls', async () => {
  const client=new NativeClient(process.execPath,['-e',worker]);
  try {
    const hello=await client.start();
    assert.equal(hello.protocolVersion,1);assert.equal(hello.preflight.ready,true);
    const [first,second]=await Promise.all([client.call('slow',{text:'你好\n世界'}),client.call('echo',{n:2})]);
    assert.equal((first.args as {text:string}).text,'你好\n世界');
    assert.equal((second.args as {n:number}).n,2);
  } finally {client.close();}
});

test('native dispatch and preflight survive bridge errors', async () => {
  const client=new NativeClient(process.execPath,['-e',worker]);
  try {
    await assert.rejects(client.call('reject'), error => {
      assert.ok(error instanceof NativeCallError);
      assert.deepEqual(error.toResult(),{status:'error',code:'desktop_environment_not_ready',message:'locked',
        dispatch:'not_started',preflight:{ready:false},verification:'not_attempted'});
      return true;
    });
    await assert.rejects(client.call('reject_partial'), error => {
      assert.ok(error instanceof NativeCallError);assert.equal(error.dispatch,'possibly_partial');return true;
    });
  } finally {client.close();}
});

test('timeout invalidates references and does not replay input', async () => {
  const client=new NativeClient(process.execPath,['-e',worker]);
  try {
    await client.start();const generation=client.generation;
    await assert.rejects(client.call('hang',{}, {timeoutMs:30}), error => {
      assert.ok(error instanceof NativeCallError);
      assert.equal(error.code,'native_timeout');assert.equal(error.dispatch,'unknown');
      assert.equal(error.referencesInvalidated,true);return true;
    });
    assert.ok(client.generation>generation);
    const recovered=await client.call('echo',{after:true});
    assert.equal((recovered.args as {after:boolean}).after,true);
  } finally {client.close();}
});

test('queued request with old references is not sent after worker timeout',async()=>{
  const client=new NativeClient(process.execPath,['-e',worker]);
  try {
    await client.start();
    const hung=client.call('hang',{}, {timeoutMs:30});
    const queued=client.call('echo',{stale:'w-1'});
    await assert.rejects(hung,error=>error instanceof NativeCallError && error.referencesInvalidated);
    await assert.rejects(queued,error=>error instanceof NativeCallError && error.code==='references_invalidated' && error.dispatch==='not_started');
  } finally {client.close();}
});
