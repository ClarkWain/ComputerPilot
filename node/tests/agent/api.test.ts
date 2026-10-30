import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AgentApi } from '../../src/agent/api.js';
import type { JsonObject } from '../../src/native/client.js';
import type { ProfileEngine } from '../../src/profiles/engine.js';

const window={windowRef:'w-1',title:'Test',pid:7,bounds:{x:100,y:200,width:800,height:600},foreground:true,enabled:true,
  client:{dip96:{width:800,height:600}},display:{dpi:96},dpi:96,dpiAwareness:'per_monitor_v2'};
function fixture() {
  const calls: Array<{operation:string,args:JsonObject}>=[];
  const native={generation:1, async call(operation:string,args:JsonObject={}) {
    calls.push({operation,args});
    if(operation==='window.list')return {status:'ok',windows:[window]};
    if(operation==='window.get')return {...window};
    if(operation==='capture.window')return {status:'ok',path:args.output,imageRef:'img-1',mimeType:'image/png',bounds:{x:100,y:200,width:800,height:600},width:400,height:300};
    if(operation==='input.click')return {status:'ok'};
    return {status:'ok'};
  }};
  const profiles={async discover(){return {status:'ok',profiles:[],unavailable:[]};},async execute(){return {status:'ok',completed:1};}} as unknown as ProfileEngine;
  return {api:new AgentApi(native,profiles),calls,native};
}

test('image observation returns path and maps screenshot pixels to physical input',async()=>{
  const {api,calls}=fixture();
  const listed=await api.call('list_windows',{});assert.equal((listed.windows as JsonObject[])[0].window_id,'w-1');
  const state=await api.call('get_window_state',{window_id:'w-1',mode:'image'});
  assert.equal((state.capture as JsonObject).delivery,'path');
  assert.equal(state.coordinateSpace,'image_pixels');
  const done=await api.call('execute_batch',{window_id:'w-1',actions:[{type:'click',point:{x:50,y:25}}]});
  assert.equal(done.status,'ok');
  const click=calls.find(x=>x.operation==='input.click');assert.ok(click);
  assert.equal(click.args.x,101);assert.equal(click.args.y,51);
  const reused=await api.call('execute_batch',{window_id:'w-1',actions:[{type:'press_keys',chord:'Enter'}]});
  assert.equal(reused.code,'state_required');
});

test('a modal appearing during activation exposes a usable blocking window identity',async()=>{
  const {api,native,calls}=fixture();
  let activated=false;
  const popup={...window,windowRef:'popup',title:'Save dialog',pid:8};
  const original=native.call.bind(native);
  native.call=async(operation:string,args:JsonObject={})=>{
    if(operation==='window.activate'){activated=true;return {status:'ok'};}
    if(operation==='window.get')return args.windowRef==='popup'?popup:
      activated?{...window,enabled:false,blockingWindow:popup}:{...window,foreground:false};
    if(operation==='ui.tree')return {status:'ok',elements:[],evidenceComplete:true};
    return original(operation,args);
  };
  await api.call('list_windows',{});
  const blocked=await api.call('get_window_state',{window_id:'w-1'});
  assert.equal(blocked.code,'window_blocked');
  assert.deepEqual(blocked.blocking_window,{window_id:'popup',title:'Save dialog',pid:8});
  const dialog=await api.call('get_window_state',{window_id:'popup',activate:false});
  assert.equal(dialog.status,'ok');assert.equal(dialog.title,'Save dialog');
  assert.equal(calls.some(call=>call.operation.startsWith('input.')),false);
});

test('partial platform outcome stops a batch before later input',async()=>{
  const {api,calls,native}=fixture();
  await api.call('list_windows',{});await api.call('get_window_state',{window_id:'w-1',mode:'image'});
  const original=native.call.bind(native);
  native.call=async (operation:string,args:JsonObject={})=>operation==='input.click'?{status:'partial',dispatch:'possibly_partial'}:original(operation,args);
  const result=await api.call('execute_batch',{window_id:'w-1',actions:[{type:'click',point:{x:1,y:1}},{type:'press_keys',chord:'Enter'}]});
  assert.equal(result.status,'error');assert.equal(result.completed,0);assert.equal(result.dispatch,'possibly_partial');
  assert.equal(calls.some(x=>x.operation==='input.key_chord'),false);
});

test('worker generation change invalidates observed controls',async()=>{
  const {api,native}=fixture();await api.call('list_windows',{});await api.call('get_window_state',{window_id:'w-1',mode:'image'});
  native.generation++;
  const result=await api.call('execute_batch',{window_id:'w-1',actions:[{type:'press_keys',chord:'Enter'}]});
  assert.equal(result.code,'state_required');
});

test('delta keeps unchanged control ids usable while reporting value changes and removals',async()=>{
  let ref='e-1',value='old',visible=true;
  const calls: Array<{operation:string,args:JsonObject}>=[];
  const element=()=>({elementRef:ref,automationId:'title',name:'Title',role:'Edit',value,
    bounds:{x:120,y:220,width:150,height:30}});
  const native={generation:1,async call(operation:string,args:JsonObject={}):Promise<JsonObject>{
    calls.push({operation,args});
    if(operation==='window.list')return {status:'ok',windows:[window]};
    if(operation==='window.get')return {...window};
    if(operation==='ui.tree')return {status:'ok',elements:visible?[element()]:[],evidenceComplete:true};
    if(operation==='ui.get')return {status:'ok',...element()};
    return {status:'ok'};
  }};
  const profiles={async discover(){return {status:'ok',profiles:[],unavailable:[]};}} as unknown as ProfileEngine;
  const api=new AgentApi(native,profiles);
  await api.call('list_windows',{});
  const first=await api.call('get_window_state',{window_id:'w-1',change_mode:'delta'});
  assert.deepEqual(first.change,{kind:'full',reason:'initial'});
  assert.equal((first.controls as JsonObject[])[0].control_id,'e-1');
  ref='e-2';
  const unchanged=await api.call('get_window_state',{window_id:'w-1',change_mode:'delta'});
  assert.deepEqual(unchanged,{status:'ok',window_id:'w-1',change:{kind:'unchanged'}});
  const fill=await api.call('execute_batch',{window_id:'w-1',actions:[{type:'fill_text',control_id:'e-1',text:'new'}]});
  assert.equal(fill.status,'ok');
  assert.equal(calls.findLast(call=>call.operation==='ui.fill')?.args.elementRef,'e-2');
  value='new';
  const changed=await api.call('get_window_state',{window_id:'w-1',change_mode:'delta'});
  assert.deepEqual(changed.controls,{updated:[{control_id:'e-1',set:{value:'new'}}]});
  visible=false;
  const removed=await api.call('get_window_state',{window_id:'w-1',change_mode:'delta'});
  assert.deepEqual(removed.controls,{removed:['e-1']});
});

test('delta omits identical screenshot and returns a changed screenshot',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop-pilot-delta-test-'));
  let image='same';
  const native={generation:1,async call(operation:string,args:JsonObject={}):Promise<JsonObject>{
    if(operation==='window.list')return {status:'ok',windows:[window]};
    if(operation==='window.get')return {...window};
    if(operation==='capture.window'){
      const path=join(directory,'capture.png');
      await writeFile(path,image);
      return {status:'ok',path,imageRef:'img',mimeType:'image/png',
        bounds:{x:100,y:200,width:800,height:600},width:400,height:300};
    }
    return {status:'ok'};
  }};
  const profiles={async discover(){return {status:'ok',profiles:[],unavailable:[]};}} as unknown as ProfileEngine;
  try {
    const api=new AgentApi(native,profiles);
    await api.call('list_windows',{});
    const args={window_id:'w-1',mode:'image',change_mode:'delta',image_delivery:'inline'};
    const first=await api.call('get_window_state',args);
    assert.equal((first.change as JsonObject).kind,'full');
    assert.ok(first.capture);
    const same=await api.call('get_window_state',args);
    assert.deepEqual(same,{status:'ok',window_id:'w-1',change:{kind:'unchanged'}});
    image='different';
    const changed=await api.call('get_window_state',args);
    assert.equal((changed.change as JsonObject).kind,'delta');
    assert.equal((changed.capture as JsonObject).delivery,'inline');
    const viewChanged=await api.call('get_window_state',{...args,max_edge:800});
    assert.deepEqual(viewChanged.change,{kind:'full',reason:'view_changed'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('small image change returns a positioned patch while input uses the full frame',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop-pilot-patch-test-'));
  const base=await sharp({create:{width:100,height:100,channels:3,background:'#000000'}}).png().toBuffer();
  const mark=await sharp({create:{width:4,height:4,channels:3,background:'#ffffff'}}).png().toBuffer();
  const edited=await sharp(base).composite([{input:mark,left:10,top:10}]).png().toBuffer();
  let image=base,index=0;
  const calls: Array<{operation:string,args:JsonObject}>=[];
  const native={generation:1,async call(operation:string,args:JsonObject={}):Promise<JsonObject>{
    calls.push({operation,args});
    if(operation==='window.list')return {status:'ok',windows:[window]};
    if(operation==='window.get')return {...window};
    if(operation==='capture.window'){
      const path=join(directory,`capture-${++index}.png`);
      await writeFile(path,image);
      return {status:'ok',path,imageRef:'img',mimeType:'image/png',
        bounds:{x:100,y:200,width:800,height:600},width:100,height:100};
    }
    return {status:'ok'};
  }};
  const profiles={async discover(){return {status:'ok',profiles:[],unavailable:[]};}} as unknown as ProfileEngine;
  try {
    const api=new AgentApi(native,profiles);
    await api.call('list_windows',{});
    const args={window_id:'w-1',mode:'image',change_mode:'delta'};
    await api.call('get_window_state',args);
    image=edited;
    const changed=await api.call('get_window_state',args);
    const capture=changed.capture as JsonObject;
    assert.equal(capture.kind,'patch');
    assert.deepEqual(capture.frame,{width:100,height:100});
    assert.ok((capture.rect as JsonObject).width as number < 100);
    const done=await api.call('execute_batch',{window_id:'w-1',actions:[{type:'click',point:{x:90,y:90}}]});
    assert.equal(done.status,'ok');
    assert.equal(calls.findLast(call=>call.operation==='input.click')?.args.x,724);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('incomplete control inspection never advances a delta baseline',async()=>{
  let complete=true;
  const native={generation:1,async call(operation:string):Promise<JsonObject>{
    if(operation==='window.list')return {status:'ok',windows:[window]};
    if(operation==='window.get')return {...window};
    if(operation==='ui.tree')return {status:'ok',elements:[],evidenceComplete:complete,
      ...(complete?{}:{truncated:true})};
    return {status:'ok'};
  }};
  const profiles={async discover(){return {status:'ok',profiles:[],unavailable:[]};}} as unknown as ProfileEngine;
  const api=new AgentApi(native,profiles);
  await api.call('list_windows',{});
  const args={window_id:'w-1',change_mode:'delta'};
  assert.equal(((await api.call('get_window_state',args)).change as JsonObject).kind,'full');
  complete=false;
  assert.deepEqual((await api.call('get_window_state',args)).change,{kind:'full',reason:'inspection_incomplete'});
  complete=true;
  assert.deepEqual((await api.call('get_window_state',args)).change,{kind:'full',reason:'initial'});
});

test('failed UI inspection discards a previously valid delta baseline',async()=>{
  let failTree=false;
  const native={generation:1,async call(operation:string):Promise<JsonObject>{
    if(operation==='window.list')return {status:'ok',windows:[window]};
    if(operation==='window.get')return {...window};
    if(operation==='ui.tree')return failTree?{status:'error',code:'ui_timeout'}:
      {status:'ok',elements:[],evidenceComplete:true};
    return {status:'ok'};
  }};
  const profiles={async discover(){return {status:'ok',profiles:[],unavailable:[]};}} as unknown as ProfileEngine;
  const api=new AgentApi(native,profiles);
  await api.call('list_windows',{});
  const args={window_id:'w-1',change_mode:'delta'};
  assert.deepEqual((await api.call('get_window_state',args)).change,{kind:'full',reason:'initial'});
  failTree=true;
  assert.equal((await api.call('get_window_state',args)).code,'ui_timeout');
  failTree=false;
  assert.deepEqual((await api.call('get_window_state',args)).change,{kind:'full',reason:'initial'});
});

test('delta omits repeated profile examples and reports changed semantic catalog',async()=>{
  let action='drawing.drawLine';
  const native={generation:1,async call(operation:string):Promise<JsonObject>{
    if(operation==='window.list')return {status:'ok',windows:[window]};
    if(operation==='window.get')return {...window};
    if(operation==='ui.tree')return {status:'ok',elements:[],evidenceComplete:true};
    return {status:'ok'};
  }};
  const profiles={async discover(){return {status:'ok',profiles:[{id:'paint',
    actions:[{action,example:{action,args:{}}}]}],unavailable:[]};}} as unknown as ProfileEngine;
  const api=new AgentApi(native,profiles);
  await api.call('list_windows',{});
  const args={window_id:'w-1',change_mode:'delta'};
  const first=await api.call('get_window_state',args);
  assert.equal((first.change as JsonObject).kind,'full');
  const unchanged=await api.call('get_window_state',args);
  assert.deepEqual(unchanged,{status:'ok',window_id:'w-1',change:{kind:'unchanged'}});
  action='drawing.drawCircle';
  const changed=await api.call('get_window_state',args);
  assert.equal((changed.change as JsonObject).kind,'delta');
  assert.equal(((((changed.semantic as JsonObject).profiles as JsonObject[])[0].actions as JsonObject[])[0]).action,
    'drawing.drawCircle');
  assert.equal(changed.controls,undefined);
});

test('cancelled observation does not become the delta baseline',async()=>{
  const controller=new AbortController();
  let gets=0;
  const native={generation:1,async call(operation:string):Promise<JsonObject>{
    if(operation==='window.list')return {status:'ok',windows:[window]};
    if(operation==='window.get'){if(++gets===2)controller.abort();return {...window};}
    if(operation==='ui.tree')return {status:'ok',elements:[],evidenceComplete:true};
    return {status:'ok'};
  }};
  const profiles={async discover(){return {status:'ok',profiles:[],unavailable:[]};}} as unknown as ProfileEngine;
  const api=new AgentApi(native,profiles);
  await api.call('list_windows',{});
  const args={window_id:'w-1',change_mode:'delta'};
  const cancelled=await api.call('get_window_state',args,{signal:controller.signal});
  assert.equal(cancelled.code,'cancelled');
  const next=await api.call('get_window_state',args);
  assert.deepEqual(next.change,{kind:'full',reason:'initial'});
});
