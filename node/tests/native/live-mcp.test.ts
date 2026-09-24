import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../../../',import.meta.url));
const native=resolve(root,'build/core/Release/desktop-pilot-native.exe');
const entry=fileURLToPath(new URL('../../src/index.js',import.meta.url));

test('real native hello and Node MCP list_windows return one structured result',
  {skip:!existsSync(native)},async()=>{
    const child=spawn(process.execPath,[entry],{cwd:root,env:{...process.env,DP_NATIVE_EXE:native},stdio:['pipe','pipe','pipe'],windowsHide:true});
    const lines=createInterface({input:child.stdout});const waiters:Array<(v:any)=>void>=[];const buffered:any[]=[];
    lines.on('line',line=>{const value=JSON.parse(line);const next=waiters.shift();if(next)next(value);else buffered.push(value);});
    const receive=()=>buffered.length?Promise.resolve(buffered.shift()):new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Live MCP response timeout')),10000);
      waiters.push(value=>{clearTimeout(timer);resolve(value);});
    });
    const send=(id:number,method:string,params:object={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    try {
      send(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'live-test',version:'1'}});
      const hello=await receive();assert.equal(hello.result.protocolVersion,'2025-06-18');
      assert.match(hello.result.instructions,/desktopPreflight|DesktopPilot/i);
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
      send(2,'tools/call',{name:'list_windows',arguments:{}});
      const result=await receive();
      assert.equal(result.id,2);assert.deepEqual(result.result.content,[]);
      assert.equal(result.result.structuredContent.status,'ok');
      assert.ok(Array.isArray(result.result.structuredContent.windows));
      assert.equal(result.result.isError,false);
      child.stdin.end();
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('MCP process did not exit after stdin closed')),3000);
        child.once('exit',()=>{clearTimeout(timer);resolve();});
      });
    } finally {child.kill();}
  });
