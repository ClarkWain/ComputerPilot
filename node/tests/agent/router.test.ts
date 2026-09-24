import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateCall } from '../../src/agent/router.js';
import type { JsonObject } from '../../src/native/client.js';

test('OCR and parser calls stay in Node; platform calls use native worker',async()=>{
  const nativeOps:string[]=[];const visionOps:string[]=[];
  const call=createPrivateCall({async call(op,args){nativeOps.push(op);return {status:'ok',args};}},
    {async call(op,args){visionOps.push(op);return {status:'ok',args};}});
  const ocr=await call('vision.ocr',{image:'c:/image.png',ocrModels:'c:/models'});
  const parse=await call('vision.parse',{image:'c:/image.png'});
  const window=await call('window.get',{windowRef:'w-1'});
  assert.equal(ocr.status,'ok');assert.equal(parse.status,'ok');assert.equal(window.status,'ok');
  assert.deepEqual(visionOps,['vision.ocr','vision.parse']);assert.deepEqual(nativeOps,['window.get']);
});

test('aborted vision work returns not_started and never reaches native',async()=>{
  const controller=new AbortController();let nativeCalls=0,visionCalls=0;
  const call=createPrivateCall({async call(){nativeCalls++;return {status:'ok'};}},
    {async call(){visionCalls++;controller.abort();return {status:'partial',ocrError:'request_cancelled'};}});
  const result=await call('vision.ocr',{}, {signal:controller.signal});
  assert.deepEqual(result,{status:'error',code:'cancelled',message:'Request cancelled during vision operation',dispatch:'not_started'});
  const next=await call('vision.ocr',{}, {signal:controller.signal});
  assert.equal(next.code,'cancelled');assert.equal(visionCalls,1);assert.equal(nativeCalls,0);
});

test('vision argument and runtime errors are typed without crossing worker',async()=>{
  let nativeCalls=0;
  const call=createPrivateCall({async call(){nativeCalls++;return {status:'ok'};}},
    {async call(_op:string,args:JsonObject){if(args.bad)throw new TypeError('bad image');throw new Error('model load failed');}});
  const bad=await call('vision.ocr',{bad:true});assert.equal(bad.code,'invalid_arguments');assert.equal(bad.dispatch,'not_started');
  const failed=await call('vision.ocr',{});assert.equal(failed.code,'vision_operation_failed');assert.equal(failed.dispatch,'not_started');
  assert.equal(nativeCalls,0);
});
