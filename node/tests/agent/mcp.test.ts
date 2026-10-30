import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicTools } from '../../src/mcp/server.js';

test('2025-06-18 MCP negotiation advertises four tools without duplicate JSON content',async()=>{
  const serverModule=fileURLToPath(new URL('../../src/mcp/server.js',import.meta.url));
  const script=`import {createServer} from ${JSON.stringify(pathToFileURL(serverModule).href)};\n`+
    `import {serveStdio} from '@modelcontextprotocol/server/stdio';\n`+
    `await serveStdio(()=>createServer({call:async()=>({status:'ok',windows:[]})},{ready:true}));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{...process.env,SESSIONNAME:`dp-mcp-test-${randomUUID()}`},
    cwd:fileURLToPath(new URL('../../../',import.meta.url))});
  const lines=createInterface({input:child.stdout});
  const buffered:unknown[]=[];const waiters:Array<(value:any)=>void>=[];
  lines.on('line',line=>{const value=JSON.parse(line);const next=waiters.shift();if(next)next(value);else buffered.push(value);});
  const receive=()=>buffered.length?Promise.resolve(buffered.shift() as any):new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('MCP response timeout')),5000);
    waiters.push(value=>{clearTimeout(timer);resolve(value);});
  });
  const send=(id:number,method:string,params:object={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  try {
    send(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
    const init=await receive();assert.equal(init.result.protocolVersion,'2025-06-18');
    assert.match(init.result.instructions,/desktopPreflight: \{"ready":true\}/);
    assert.deepEqual(init.result.serverInfo._meta['desktopPilot/desktopPreflight'],{ready:true});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    send(2,'tools/list');const listed=await receive();
    assert.deepEqual(listed.result.tools.map((tool:{name:string})=>tool.name),['list_windows','get_window_state','execute_semantic','execute_batch']);
    for(const source of publicTools) {
      const tool=listed.result.tools.find((item:{name:string})=>item.name===source.name);
      assert.deepEqual(tool.inputSchema,source.inputSchema,`${source.name}: SDK must preserve the published schema`);
      assert.equal(tool.description,source.description);
    }
    send(3,'tools/call',{name:'list_windows',arguments:{}});const call=await receive();
    assert.deepEqual(call.result.content,[]);assert.deepEqual(call.result.structuredContent,{status:'ok',windows:[]});
  } finally {child.kill();}
});

test('unchanged delta does not attach an inline MCP image',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop-pilot-mcp-delta-'));
  const file=join(directory,'pixel.png');
  await writeFile(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64'));
  const serverModule=fileURLToPath(new URL('../../src/mcp/server.js',import.meta.url));
  const script=`import {createServer} from ${JSON.stringify(pathToFileURL(serverModule).href)};\n`+
    `import {serveStdio} from '@modelcontextprotocol/server/stdio';\n`+
    `let count=0;await serveStdio(()=>createServer({call:async()=>++count===1?`+
    `{status:'ok',window_id:'w',change:{kind:'full'},capture:{delivery:'inline',path:${JSON.stringify(file)},imageRef:'img'}}:`+
    `{status:'ok',window_id:'w',change:{kind:'unchanged'}}}));`;
  // This fake AgentApi never touches the desktop. Isolate its lock namespace
  // from parallel Replay tests that independently exercise input locking.
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{...process.env,SESSIONNAME:`dp-mcp-test-${randomUUID()}`},
    cwd:fileURLToPath(new URL('../../../',import.meta.url))});
  const lines=createInterface({input:child.stdout});
  const buffered:any[]=[];const waiters:Array<(value:any)=>void>=[];
  lines.on('line',line=>{const value=JSON.parse(line);const next=waiters.shift();if(next)next(value);else buffered.push(value);});
  const receive=()=>buffered.length?Promise.resolve(buffered.shift()):new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('MCP response timeout')),5000);
    waiters.push(value=>{clearTimeout(timer);resolve(value);});
  });
  const send=(id:number,method:string,params:object={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  try {
    send(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
    await receive();child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    send(2,'tools/call',{name:'get_window_state',arguments:{window_id:'w',mode:'image',change_mode:'delta',image_delivery:'inline'}});
    const first=await receive();assert.equal(first.result.structuredContent.status,'ok',JSON.stringify(first));
    assert.equal(first.result.content.length,1);assert.equal(first.result.content[0].type,'image');
    send(3,'tools/call',{name:'get_window_state',arguments:{window_id:'w',mode:'image',change_mode:'delta',image_delivery:'inline'}});
    const second=await receive();assert.deepEqual(second.result.content,[]);
    assert.equal(second.result.structuredContent.change.kind,'unchanged');
  } finally {child.kill();await rm(directory,{recursive:true,force:true});}
});

test('MCP image options reach AgentApi only in supported modes; invalid combinations dispatch nothing',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop-pilot-mcp-options-'));
  const file=join(directory,'pixel.png');
  await writeFile(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64'));
  const serverModule=pathToFileURL(fileURLToPath(new URL('../../src/mcp/server.js',import.meta.url))).href;
  const agentModule=pathToFileURL(fileURLToPath(new URL('../../src/agent/api.js',import.meta.url))).href;
  const script=`import {createServer} from ${JSON.stringify(serverModule)};\n`+
    `import {AgentApi} from ${JSON.stringify(agentModule)};\n`+
    `import {serveStdio} from '@modelcontextprotocol/server/stdio';\n`+
    `const operations=[];const window={windowRef:'w',title:'Test',pid:1,foreground:true,enabled:true,bounds:{x:0,y:0,width:10,height:10}};`+
    `const native={generation:1,call:async(operation,args)=>{operations.push(operation);`+
    `if(operation==='window.list')return {status:'ok',windows:[window]};`+
    `if(operation==='window.get')return window;`+
    `if(operation==='ui.tree')return {status:'ok',elements:[],evidenceComplete:true};`+
    `if(operation==='capture.window')return {status:'ok',path:${JSON.stringify(file)},imageRef:'img',width:1,height:1};`+
    `return {status:'ok'};}};`+
    `const api=new AgentApi(native,{discover:async()=>({status:'ok',profiles:[],unavailable:[]})});`+
    `await serveStdio(()=>createServer({call:async(...args)=>{const result=await api.call(...args);`+
    `return {...result,nativeOperations:operations.splice(0)};}}));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{...process.env,SESSIONNAME:`dp-mcp-test-${randomUUID()}`},
    cwd:fileURLToPath(new URL('../../../',import.meta.url))});
  const buffered:any[]=[];const waiters:Array<(value:any)=>void>=[];
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{const value=JSON.parse(line);const next=waiters.shift();if(next)next(value);else buffered.push(value);});
  const receive=()=>buffered.length?Promise.resolve(buffered.shift()):new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('MCP response timeout')),5000);
    waiters.push(value=>{clearTimeout(timer);resolve(value);});
  });
  let id=0;
  const send=(method:string,params:object={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method,params})+'\n');
  try {
    send('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
    await receive();child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    send('tools/call',{name:'list_windows',arguments:{}});await receive();
    for(const args of [{image_delivery:'inline'},
      {mode:'controls',region:{x:0,y:0,width:1,height:1}},{mode:'controls',max_edge:1}]) {
      send('tools/call',{name:'get_window_state',arguments:{window_id:'w',...args}});
      const reply=await receive();
      assert.equal(reply.result.isError,true,JSON.stringify(reply));
      assert.equal(reply.result.structuredContent.code,'invalid_arguments');
      assert.deepEqual(reply.result.structuredContent.nativeOperations,[]);
    }
    for(const args of [{}, {mode:'image',image_delivery:'inline'},
      {mode:'both',region:{x:0,y:0,width:1,height:1},max_edge:1}]) {
      send('tools/call',{name:'get_window_state',arguments:{window_id:'w',...args}});
      const reply=await receive();
      assert.equal(reply.result.structuredContent.status,'ok',JSON.stringify(reply));
      assert.equal(reply.result.content.length,'image_delivery' in args?1:0);
      const operations=reply.result.structuredContent.nativeOperations as string[];
      assert.equal(operations.some(operation=>operation.startsWith('input.')),false);
      assert.equal(operations.includes('capture.window'),'mode' in args);
      assert.equal(operations.includes('ui.tree'),args.mode!=='image');
    }
  } finally {child.kill();await rm(directory,{recursive:true,force:true});}
});

test('inline image delivery failure preserves observation and partial action receipts',async()=>{
  const capture={delivery:'inline',path:join(tmpdir(),`desktop-pilot-missing-${randomUUID()}.png`),imageRef:'img'};
  const values=[
    {status:'ok',window_id:'w',controls:[],capture},
    {status:'error',completed:1,failedIndex:1,dispatch:'possibly_partial',
      failure:{status:'error',code:'action_failed',capture}},
    {status:'ok',completed:2,verification:'scene_dispatched',capture}
  ];
  const serverModule=fileURLToPath(new URL('../../src/mcp/server.js',import.meta.url));
  const script=`import {createServer} from ${JSON.stringify(pathToFileURL(serverModule).href)};\n`+
    `import {serveStdio} from '@modelcontextprotocol/server/stdio';\n`+
    `const values=${JSON.stringify(values)};await serveStdio(()=>createServer({call:async()=>values.shift()}));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{...process.env,SESSIONNAME:`dp-mcp-test-${randomUUID()}`},
    cwd:fileURLToPath(new URL('../../../',import.meta.url))});
  const buffered:any[]=[];const waiters:Array<(value:any)=>void>=[];
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{const value=JSON.parse(line);const next=waiters.shift();if(next)next(value);else buffered.push(value);});
  const receive=()=>buffered.length?Promise.resolve(buffered.shift()):new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('MCP response timeout')),5000);
    waiters.push(value=>{clearTimeout(timer);resolve(value);});
  });
  const send=(id:number,method:string,params:object={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  try {
    send(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
    await receive();child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    for(let index=0;index<values.length;index++) {
      send(index+2,'tools/call',index===0?
        {name:'get_window_state',arguments:{window_id:'w',mode:'image',image_delivery:'inline'}}:
        {name:'execute_semantic',arguments:{window_id:'w',actions:[{action:'drawing.drawCircle',args:{center:[20,20],radius:10}}]}});
      const reply=await receive(),result=reply.result.structuredContent;
      assert.equal(reply.result.isError,true);assert.deepEqual(reply.result.content,[]);
      assert.equal(result.code,'image_read_failed');assert.deepEqual(result.actionResult,values[index]);
      if(index===0)assert.deepEqual(result.controls,[]);
      else {
        assert.equal(result.completed,values[index].completed);
        assert.equal(result.dispatch,index===1?'possibly_partial':'unknown');
        if(index===1){assert.equal(result.failedIndex,1);assert.deepEqual(result.failure,values[index].failure);}
      }
    }
  } finally {child.kill();}
});
