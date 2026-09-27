import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli=fileURLToPath(new URL('../src/orchestration/cli.js',import.meta.url));
async function call(args:string[]):Promise<{code:number|null;value:Record<string,unknown>}> {
  const child=spawn(process.execPath,[cli,...args],{windowsHide:true,
    env:{...process.env,DP_NATIVE_EXE:'Z:/missing-desktop-worker.exe'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(stderr,'');
  return {code,value:JSON.parse(stdout) as Record<string,unknown>};
}

test('CLI validates and resumes a trusted decision workflow without starting the desktop worker',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dp-orchestration-cli-'));
  const script=join(root,'workflow.mjs'),definition=join(root,'definition.json'),run=join(root,'run');
  try {
    await writeFile(script,`export default async ctx => {
      const input=await ctx.readInput('input');
      if(input.review) await ctx.ask('answer',{question:'Include?',choices:['yes','no']});
      await ctx.checkpoint('done');
    }`);
    await writeFile(definition,JSON.stringify({schemaVersion:1,name:'CLI smoke',script:'./workflow.mjs',
      input:{review:true}}));
    const validated=await call(['validate',definition]);
    assert.equal(validated.code,0);assert.equal(validated.value.scriptLoaded,false);
    const started=await call(['run',definition,'--trusted-script',script,'--run-dir',run]);
    assert.equal(started.code,1);assert.equal(started.value.status,'waiting_decision');
    const answered=await call(['answer',run,'--choice','yes']);
    assert.equal(answered.code,0);
    const resumed=await call(['resume',run,'--trusted-script',script]);
    assert.equal(resumed.code,0);assert.equal(resumed.value.status,'completed');
  } finally {await rm(root,{recursive:true,force:true});}
});
