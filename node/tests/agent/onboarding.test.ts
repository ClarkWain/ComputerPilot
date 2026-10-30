import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../../../',import.meta.url));
const hasPowerShell=process.platform==='win32' && spawnSync('pwsh',['-NoProfile','-Command','exit 0']).status===0;

test('PowerShell client budgets batch delays, keeps semantic budget and accepts an explicit timeout',
  {skip:!hasPowerShell},()=>{
  const result=spawnSync('pwsh',['-NoProfile','-Command',`
    . $env:DP_TEST_CLIENT
    function Send-Pilot($Client,$Method,$Params,[int]$TimeoutMs){return @{structuredContent=@{timeout=$TimeoutMs}}}
    $batch=@{actions=@(@{delay_ms=10000},@{delay_ms=10000},@{delay_ms=10000},@{delay_ms=10000},@{})}
    $invalidRejected=$false;try {Call-Pilot @{} list_windows @{} -TimeoutMs 0 | Out-Null}catch {$invalidRejected=$true}
    @{
      ordinary=(Call-Pilot @{} list_windows @{}).timeout
      batch=(Call-Pilot @{} execute_batch $batch).timeout
      maximumBatch=(Call-Pilot @{} execute_batch @{actions=@(1..256 | ForEach-Object {@{delay_ms=10000}})}).timeout
      semantic=(Call-Pilot @{} execute_semantic @{}).timeout
      explicitBatch=(Call-Pilot @{} execute_batch $batch -TimeoutMs 75).timeout
      explicitSemantic=(Call-Pilot @{} execute_semantic @{} -TimeoutMs 80).timeout
      invalidRejected=$invalidRejected
    } | ConvertTo-Json -Compress
  `],{env:{...process.env,DP_TEST_CLIENT:join(root,'examples/onboarding/client.ps1')},
    encoding:'utf8',timeout:20000,windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{ordinary:30000,batch:70000,maximumBatch:2590000,
    semantic:610000,explicitBatch:75,explicitSemantic:80,invalidRejected:true});
});

test('PowerShell client blocks writes after transport failure but keeps a tool-error connection reusable',
  {skip:!hasPowerShell},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop pilot client '));
  const entry=join(directory,'fake.js');const calls=join(directory,'calls.jsonl');
  try {
    // Real stdio and PowerShell async reads, without a native worker or GUI input.
    await writeFile(entry,`const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);if(!request.id)return;
  const mode=request.params?.arguments?.mode;
  appendFileSync(process.env.DP_TEST_CALLS,JSON.stringify({method:request.method,mode})+'\\n');
  const reply=(result,id=request.id)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
  if(request.method==='initialize')return reply({serverInfo:{name:'fake',version:'1'}});
  if(mode==='slow')return setTimeout(()=>reply({structuredContent:{status:'ok'}}),500);
  if(mode==='wrong_id')return reply({},request.id+1);
  if(mode==='eof')return process.exit(0);
  if(mode==='invalid_json')return process.stdout.write('invalid json\\n');
  reply({isError:mode==='tool_error',structuredContent:{status:mode==='tool_error'?'error':'ok'}});
});`);
    const result=spawnSync('pwsh',['-NoProfile','-Command',`
      . $env:DP_TEST_CLIENT
      $failures=@()
      foreach($mode in @('slow','wrong_id','eof','invalid_json')){
        $client=Open-Pilot $env:DP_TEST_ENTRY
        try {
          $timeout=if($mode -eq 'slow'){100}else{1000}
          $first='';try {Call-Pilot $client execute_batch @{mode=$mode} -TimeoutMs $timeout | Out-Null}catch {$first=$_.ToString()}
          $blocked='';try {Call-Pilot $client list_windows @{mode='must_not_send'} | Out-Null}catch {$blocked=$_.ToString()}
          $failures+=@{mode=$mode;first=$first;blocked=$blocked;faulted=$client.Faulted}
        }finally {Close-Pilot $client;Close-Pilot $client}
      }
      $client=Open-Pilot $env:DP_TEST_ENTRY
      try {
        $toolError=$false;try {Call-Pilot $client list_windows @{mode='tool_error'} | Out-Null}catch {$toolError=$true}
        $continued=Call-Pilot $client list_windows @{mode='ok'}
      }finally {Close-Pilot $client}
      $closedBlocked=$false;try {Call-Pilot $client list_windows @{mode='must_not_send'} | Out-Null}catch {$closedBlocked=$true}
      @{failures=$failures;toolError=$toolError;continued=$continued.status;closedBlocked=$closedBlocked} | ConvertTo-Json -Depth 5 -Compress
    `],{env:{...process.env,DP_TEST_CLIENT:join(root,'examples/onboarding/client.ps1'),
      DP_TEST_ENTRY:entry,DP_TEST_CALLS:calls},encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const outcome=JSON.parse(result.stdout);
    assert.equal(outcome.toolError,true);assert.equal(outcome.continued,'ok');assert.equal(outcome.closedBlocked,true);
    const reasons=['Response timeout','Unexpected response id','Server closed stdout','JSON'];
    for(const [index,failure] of outcome.failures.entries()){
      assert.equal(failure.faulted,true);
      assert.match(failure.first,new RegExp(reasons[index],'i'));
      assert.match(failure.first,/Close-Pilot.*reconnect.*Do not blindly resend/);
      assert.match(failure.blocked,/Client is unusable/);
    }
    const log=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(log.filter(request=>request.method==='tools/call').map(request=>request.mode),
      ['slow','wrong_id','eof','invalid_json','tool_error','ok']);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('drawing uses observed compact control bounds and rejects an invalid rectangle before input',
  {skip:!hasPowerShell},()=>{
  // Extract only Point from the actual demo; do not open a fixture or send input.
  const result=spawnSync('pwsh',['-NoProfile','-Command',`
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($env:DP_TEST_DRAW,[ref]$tokens,[ref]$errors)
    $point=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Point'},$true)
    Invoke-Expression $point.Extent.Text
    $nodes=@{Cell=@{bounds=@(103,207,31,19)}}
    $valid=Point Cell
    $nodes.Cell.bounds=@(103,207,0,19)
    $rejected=$false;try {Point Cell | Out-Null}catch {$rejected=$true}
    @{point=$valid;invalidRejected=$rejected} | ConvertTo-Json -Compress
  `],{env:{...process.env,DP_TEST_DRAW:join(root,'examples/onboarding/draw-demo.ps1')},
    encoding:'utf8',timeout:20000,windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{point:{x:118,y:216},invalidRejected:true});
});

test('onboarding selects Node from any cwd and rejects false or missing preflight without calling tools',
  {skip:!hasPowerShell},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop pilot onboarding '));
  const entry=join(directory,'node/dist/src/index.js');
  const calls=join(directory,'calls.jsonl');
  try {
    await cp(join(root,'examples/onboarding'),join(directory,'examples/onboarding'),{recursive:true});
    await mkdir(dirname(entry),{recursive:true});
    // A stale legacy build must not win discovery over the current Node entry.
    await mkdir(join(directory,'build/core/Release'),{recursive:true});
    await writeFile(join(directory,'build/core/Release/desktop-pilot.exe'),'stale executable');
    await writeFile(entry,`const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);if(!request.id)return;
  appendFileSync(process.env.DP_TEST_CALLS,request.method+'\\n');
  const preflight=JSON.parse(process.env.DP_TEST_PREFLIGHT);
  const result=request.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fake',version:'1',
    ...(process.env.DP_TEST_LEGACY?'':{_meta:{'desktopPilot/desktopPreflight':preflight}})},
    ...(process.env.DP_TEST_LEGACY?{_meta:{'desktopPilot/desktopPreflight':preflight}}:{})}:
    {content:[],structuredContent:{status:'ok',windows:[]}};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`);
    for(const [preflight,code,legacy] of [[{ready:true},0,false],[{ready:false,reason:'session_locked'},3,false],
      [{},1,false],[{ready:true},0,true]] as const) {
      await writeFile(calls,'');
      const result=spawnSync('pwsh',['-NoProfile','-File',join(directory,'examples/onboarding/start.ps1'),'-Task','check'],{
        cwd:tmpdir(),env:{...process.env,DP_TEST_CALLS:calls,DP_TEST_PREFLIGHT:JSON.stringify(preflight),
          DP_TEST_LEGACY:legacy?'1':''},encoding:'utf8',timeout:20000,windowsHide:true});
      assert.equal(result.status,code,result.stdout+result.stderr);
      assert.equal(await readFile(calls,'utf8'),code===0?'initialize\ntools/call\n':'initialize\n');
      if(code===0) assert.equal(JSON.parse(result.stdout).status,'ready');
      if(code===3) assert.equal(JSON.parse(result.stdout).ready,false);
    }
    const explicit=spawnSync('pwsh',['-NoProfile','-File',join(directory,'examples/onboarding/start.ps1'),
      '-Executable',entry,'-Task','check'],{cwd:tmpdir(),env:{...process.env,DP_TEST_CALLS:calls,
        DP_TEST_PREFLIGHT:'{"ready":true}'},encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(explicit.status,0,explicit.stdout+explicit.stderr);
    const inherited=spawnSync('pwsh',['-NoProfile','-Command',
      "$global:LASTEXITCODE=17; & $env:DP_TEST_START -Task check; if($LASTEXITCODE -eq 17){exit 0}else{exit 1}"],{
      cwd:tmpdir(),env:{...process.env,DP_TEST_CALLS:calls,DP_TEST_PREFLIGHT:'{"ready":true}',
        DP_TEST_START:join(directory,'examples/onboarding/start.ps1')},encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(inherited.status,0,inherited.stdout+inherited.stderr);
    assert.equal(JSON.parse(inherited.stdout).status,'ready');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('onboarding finds its fixture beside a custom native worker from any cwd',
  {skip:!hasPowerShell},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop pilot fixture '));
  try {
    const worker=join(directory,'custom worker/desktop-pilot-native.exe');
    const fixture=join(dirname(worker),'desktop-pilot-onboarding.exe');
    const entry=join(directory,'node/dist/src/index.js');
    await mkdir(dirname(worker),{recursive:true});await mkdir(dirname(entry),{recursive:true});
    await writeFile(worker,'');await writeFile(fixture,'');await writeFile(entry,'');
    const result=spawnSync('pwsh',['-NoProfile','-Command',
      '. $env:DP_TEST_CLIENT; Find-PilotFixture $env:DP_TEST_ENTRY'],{
      cwd:tmpdir(),env:{...process.env,DP_NATIVE_EXE:worker,DP_TEST_ENTRY:entry,
        DP_TEST_CLIENT:join(root,'examples/onboarding/client.ps1')},encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.equal(await realpath(result.stdout.trim()),await realpath(fixture));
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('skill installation saves resolved Node command and entry arguments instead of a stale core',
  {skip:!hasPowerShell},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop pilot install '));
  try {
    await cp(join(root,'skills/desktoppilot'),join(directory,'skills/desktoppilot'),{recursive:true});
    const entry=join(directory,'node/dist/src/index.js');
    await mkdir(dirname(entry),{recursive:true});await writeFile(entry,'');
    await mkdir(join(directory,'build/core/Release'),{recursive:true});
    await writeFile(join(directory,'build/core/Release/desktop-pilot.exe'),'stale executable');
    const destination=join(directory,'installed skills');
    const result=spawnSync('pwsh',['-NoProfile','-File',join(directory,'skills/desktoppilot/scripts/install.ps1'),
      '-SkillsDirectory',destination],{cwd:tmpdir(),encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const hint=JSON.parse(await readFile(join(destination,'desktoppilot/installation.json'),'utf8'));
    assert.equal(hint.executable.toLowerCase(),process.execPath.toLowerCase());
    assert.equal(hint.args.length,1);
    assert.equal(await realpath(hint.args[0]),await realpath(entry));
    assert.equal(await realpath(hint.root),await realpath(directory));
  } finally {await rm(directory,{recursive:true,force:true});}
});
