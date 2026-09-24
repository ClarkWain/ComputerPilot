import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('2025-06-18 MCP negotiation advertises four tools without duplicate JSON content',async()=>{
  const serverModule=fileURLToPath(new URL('../../src/mcp/server.js',import.meta.url));
  const script=`import {createServer} from ${JSON.stringify(pathToFileURL(serverModule).href)};\n`+
    `import {serveStdio} from '@modelcontextprotocol/server/stdio';\n`+
    `await serveStdio(()=>createServer({call:async()=>({status:'ok',windows:[]})},{ready:true}));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe'],windowsHide:true,
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
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    send(2,'tools/list');const listed=await receive();
    assert.deepEqual(listed.result.tools.map((tool:{name:string})=>tool.name),['list_windows','get_window_state','execute_semantic','execute_batch']);
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
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe'],windowsHide:true,
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
    const first=await receive();assert.equal(first.result.content.length,1);assert.equal(first.result.content[0].type,'image');
    send(3,'tools/call',{name:'get_window_state',arguments:{window_id:'w',mode:'image',change_mode:'delta',image_delivery:'inline'}});
    const second=await receive();assert.deepEqual(second.result.content,[]);
    assert.equal(second.result.structuredContent.change.kind,'unchanged');
  } finally {child.kill();await rm(directory,{recursive:true,force:true});}
});
