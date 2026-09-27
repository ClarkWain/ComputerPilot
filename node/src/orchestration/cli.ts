import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentApi } from '../agent/api.js';
import { createPrivateCall } from '../agent/router.js';
import { NativeClient } from '../native/client.js';
import { ProfileEngine } from '../profiles/engine.js';
import { NodeVision } from '../vision/service.js';
import { assertExistingDirectoryNoLinks, sha256File } from '../workflow/paths.js';
import { sha256Text, stableJson } from '../workflow/plan.js';
import { isRunLockActive } from '../workflow/journal.js';
import { createDesktopOrchestrationHost } from './desktop-host.js';
import { answerOrchestration, orchestrationStatus, reconcileOrchestration, repairOrchestrationTail, resumeOrchestration,
  startOrchestration } from './runner.js';
import type { OrchestrationDefinition, OrchestrationHost } from './types.js';

type Draft = { schemaVersion: 1; name: string; script: string; input: unknown };
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');

function options(argv: string[]): { positionals: string[]; flags: Map<string,string> } {
  const positionals: string[] = [], flags = new Map<string,string>();
  for (let i=0;i<argv.length;i++) {
    const value=argv[i];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const name=value.slice(2), next=argv[++i];
    if (!['run-dir','trusted-script','choice','reason','result-json'].includes(name) || flags.has(name) || !next)
      throw new Error(`Invalid option: ${value}`);
    flags.set(name,next);
  }
  return {positionals,flags};
}

async function draft(path: string): Promise<Draft> {
  const absolute=resolve(path);
  const value=JSON.parse(await readFile(absolute,'utf8')) as Record<string,unknown>;
  if (!value || typeof value!=='object' || value.schemaVersion!==1 ||
      typeof value.name!=='string' || !value.name.trim() || typeof value.script!=='string' ||
      !value.script.trim() || !('input' in value) ||
      Object.keys(value).some(key=>!['schemaVersion','name','script','input'].includes(key)))
    throw new Error('Definition requires schemaVersion, name, script and input');
  stableJson(value.input);
  const script=isAbsolute(value.script)?resolve(value.script):resolve(dirname(absolute),value.script);
  await sha256File(script);
  return {schemaVersion:1,name:value.name,script,input:value.input};
}

async function desktopHost(runDirectory: string): Promise<{host: OrchestrationHost; close():void}> {
  let native: NativeClient | undefined;
  let actual: OrchestrationHost | undefined;
  const ensure = async (): Promise<OrchestrationHost> => {
    if (actual) return actual;
  const executable=process.env.DP_NATIVE_EXE ?? [
    resolve(packageRoot,'native/desktop-pilot-native.exe'),
    resolve(packageRoot,'build/release/Release/desktop-pilot-native.exe')
  ].find(existsSync) ?? resolve(packageRoot,'native/desktop-pilot-native.exe');
  native=new NativeClient(executable);
  try {
    const hello=await native.start();
    if (hello.preflight.ready!==true) throw new Error(`Desktop unavailable: ${JSON.stringify(hello.preflight)}`);
    const call=createPrivateCall(native,new NodeVision());
    const profiles=new ProfileEngine((operation,args,settings)=>call(operation,args,settings),
      process.env.DP_PROFILES_DIR ?? resolve(packageRoot,'profiles'));
    actual=createDesktopOrchestrationHost(new AgentApi(native,profiles),runDirectory);
    return actual;
  } catch(error) {native.close();native=undefined;throw error;}
  };
  return {host:{execute:async request=>(await ensure()).execute(request),
    releaseDesktop:async()=>actual?.releaseDesktop?.()},close:()=>native?.close()};
}

async function requestControl(runDirectory: string, request: 'pause'|'cancel'): Promise<unknown> {
  const root=resolve(runDirectory),guard=join(root,'control.lock');
  await assertExistingDirectoryNoLinks(root);
  await mkdir(guard);
  const temporary=join(root,`.control-${randomUUID()}.tmp`);
  try {
    const status=await orchestrationStatus(root);
    if (status.status!=='running' || !await isRunLockActive(root))
      throw new Error('Control requests require an active workflow run');
    await writeFile(temporary,JSON.stringify({request})+'\n',{flag:'wx'});
    await rename(temporary,join(root,'control.json'));
    return {ok:true,request,effectiveAt:'next command boundary',runDirectory:root};
  } finally {await rm(temporary,{force:true});await rmdir(guard);}
}

async function execute(argv: string[]): Promise<unknown> {
  const [command,...rest]=argv;
  const {positionals,flags}=options(rest);
  if (command==='validate') {
    if(positionals.length!==1||flags.size)throw new Error('Usage: orchestration validate <definition.json>');
    const value=await draft(positionals[0]);
    return {ok:true,name:value.name,script:value.script,scriptSha256:await sha256File(value.script),
      inputSha256:sha256Text(stableJson(value.input)),scriptLoaded:false,desktopInspected:false};
  }
  if (command==='status') {
    if(positionals.length!==1||flags.size)throw new Error('Usage: orchestration status <run-dir>');
    return orchestrationStatus(positionals[0]);
  }
  if (command==='pause' || command==='cancel') {
    if(positionals.length!==1||flags.size)throw new Error(`Usage: orchestration ${command} <run-dir>`);
    return requestControl(positionals[0],command);
  }
  if (command==='answer') {
    if(positionals.length!==1||flags.size!==1||!flags.has('choice'))
      throw new Error('Usage: orchestration answer <run-dir> --choice <recorded-choice>');
    return answerOrchestration(positionals[0],flags.get('choice')!);
  }
  if (command==='repair-tail') {
    if(positionals.length!==1||flags.size!==1||!flags.has('reason'))
      throw new Error('Usage: orchestration repair-tail <run-dir> --reason <text>');
    return repairOrchestrationTail(positionals[0],flags.get('reason')!);
  }
  if (command==='reconcile') {
    if(positionals.length!==2||flags.size!==2||!flags.has('reason')||!flags.has('result-json'))
      throw new Error('Usage: orchestration reconcile <run-dir> <command-key> --result-json <file> --reason <text>');
    const value=JSON.parse(await readFile(resolve(flags.get('result-json')!),'utf8'));
    return reconcileOrchestration(positionals[0],positionals[1],value,flags.get('reason')!);
  }
  if (command==='run') {
    if(positionals.length!==1||[...flags.keys()].some(key=>!['run-dir','trusted-script'].includes(key)))
      throw new Error('Usage: orchestration run <definition.json> --trusted-script <same-script> [--run-dir <new-dir>]');
    const value=await draft(positionals[0]);
    if (!flags.has('trusted-script') || resolve(flags.get('trusted-script')!)!==value.script)
      throw new Error('Explicit --trusted-script must match the definition script');
    const runDirectory=resolve(flags.get('run-dir') ?? join('workflow-runs',`orchestration-${randomUUID()}`));
    const opened=await desktopHost(runDirectory);
    try {return await startOrchestration(value.name,value.script,value.input,runDirectory,opened.host);}
    finally {opened.close();}
  }
  if (command==='resume') {
    if(positionals.length!==1||flags.size!==1||!flags.has('trusted-script'))
      throw new Error('Usage: orchestration resume <run-dir> --trusted-script <same-script>');
    const runDirectory=resolve(positionals[0]);
    const frozen=JSON.parse(await readFile(join(runDirectory,'definition.json'),'utf8')) as OrchestrationDefinition;
    if (resolve(flags.get('trusted-script')!)!==frozen.script)
      throw new Error('Trusted script path differs from the frozen run');
    const opened=await desktopHost(runDirectory);
    try {return await resumeOrchestration(runDirectory,opened.host);}
    finally {opened.close();}
  }
  throw new Error('Usage: orchestration <validate|run|status|pause|cancel|answer|resume|reconcile|repair-tail> ...');
}

export async function main(argv=process.argv.slice(2)): Promise<void> {
  try {
    const result=await execute(argv);
    process.stdout.write(JSON.stringify(result)+'\n');
    if (['run','resume'].includes(argv[0]) && (result as {status?:string}).status!=='completed') process.exitCode=1;
  }
  catch(error) { process.stdout.write(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)})+'\n');
    process.exitCode=1; }
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main();
