import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { answerOrchestration, orchestrationStatus, reconcileOrchestration, repairOrchestrationTail,
  resumeOrchestration, startOrchestration } from '../orchestration/runner.js';
import type { OrchestrationDefinition, OrchestrationReport } from '../orchestration/types.js';
import { ensureDirectoryNoLinks } from '../workflow/paths.js';
import { acquireRunLock } from '../workflow/journal.js';
import { SunoBrowser, sunoProfileDirectory } from './browser.js';
import { createSunoHost } from './host.js';
import { validateSunoSong } from './input.js';

const workflow=fileURLToPath(new URL('./workflow.js',import.meta.url));
function parse(argv:string[]):{positionals:string[];flags:Map<string,string>} {
  const positionals:string[]=[],flags=new Map<string,string>();
  for(let i=0;i<argv.length;i++) {
    const token=argv[i];
    if(!token.startsWith('--')){positionals.push(token);continue;}
    const key=token.slice(2),value=argv[++i];
    if(!['run-dir','profile-dir','choice','reason','result-json'].includes(key)||!value||flags.has(key))
      throw new Error(`Invalid Suno option: ${token}`);
    flags.set(key,value);
  }
  return {positionals,flags};
}
function allowed(flags:Map<string,string>,names:string[]):void {
  if([...flags.keys()].some(key=>!names.includes(key))) throw new Error('Unexpected Suno option');
}
function rootForRuns():string {
  const local=process.env.LOCALAPPDATA;
  if(!local)throw new Error('LOCALAPPDATA is required for Suno runs');
  return resolve(local,'DesktopPilot','suno-runs');
}
async function frozenProfile(runDirectory:string):Promise<string> {
  const value=JSON.parse(await readFile(join(resolve(runDirectory),'definition.json'),'utf8')) as OrchestrationDefinition;
  const input=value.input as {profileDirectory?:unknown};
  if(typeof input?.profileDirectory!=='string')throw new Error('Frozen Suno profile directory is missing');
  return resolve(input.profileDirectory);
}
async function execute(argv:string[]):Promise<unknown> {
  const [command,...rest]=argv;
  const {positionals,flags}=parse(rest);
  if(command==='validate') {
    if(positionals.length!==1||flags.size)throw new Error('Usage: suno validate <song.json>');
    const song=validateSunoSong(JSON.parse(await readFile(resolve(positionals[0]),'utf8')));
    return {ok:true,title:song.title,lyricsCharacters:song.lyrics.length,styleCharacters:song.style.length,
      browserStarted:false};
  }
  if(command==='login'||command==='inspect-site') {
    if(positionals.length)throw new Error(`Usage: suno ${command} [--profile-dir <dir>]`);
    allowed(flags,['profile-dir']);
    const browser=new SunoBrowser(resolve(flags.get('profile-dir')??sunoProfileDirectory()));
    if(command==='login'){await browser.openLogin();return {ok:true,loginWindowOpened:true,
      message:'Complete Suno login in the dedicated Edge window, then run inspect-site.'};}
    return browser.inspect();
  }
  if(command==='create') {
    if(positionals.length!==1)throw new Error('Usage: suno create <song.json> [--run-dir <new-dir>] [--profile-dir <dir>]');
    allowed(flags,['run-dir','profile-dir']);
    const song=validateSunoSong(JSON.parse(await readFile(resolve(positionals[0]),'utf8')));
    const profileDirectory=resolve(flags.get('profile-dir')??sunoProfileDirectory());
    const runDirectory=resolve(flags.get('run-dir')??join(rootForRuns(),`song-${randomUUID()}`));
    await ensureDirectoryNoLinks(dirname(runDirectory));
    process.stderr.write(`Suno run directory: ${runDirectory}\n`);
    return startOrchestration(`Suno: ${song.title}`,workflow,{...song,profileDirectory},
      runDirectory,createSunoHost(profileDirectory));
  }
  if(command==='status') {
    if(positionals.length!==1||flags.size)throw new Error('Usage: suno status <run-dir>');
    return orchestrationStatus(positionals[0]);
  }
  if(command==='check') {
    if(positionals.length!==1||flags.size)throw new Error('Usage: suno check <run-dir>');
    const report=await orchestrationStatus(positionals[0]);
    const outcome=report.result as {status?:unknown;trackUrls?:unknown;title?:unknown}|undefined;
    if(report.status!=='completed'||!outcome||
        !['ready','submitted_pending'].includes(String(outcome.status))||
        !Array.isArray(outcome.trackUrls)||!outcome.trackUrls.length||
        outcome.trackUrls.some(url=>typeof url!=='string'))
      throw new Error('Suno run has no recorded submitted song URLs to check');
    const profile=await frozenProfile(positionals[0]);
    await ensureDirectoryNoLinks(profile);
    const release=await acquireRunLock(profile);
    try {
      const checked=await new SunoBrowser(profile).wait(outcome.trackUrls as string[],60_000);
      return {title:outcome.title,...checked,runDirectory:report.runDirectory};
    } finally {await release();}
  }
  if(command==='resume') {
    if(positionals.length!==1||flags.size)throw new Error('Usage: suno resume <run-dir>');
    return resumeOrchestration(positionals[0],createSunoHost(await frozenProfile(positionals[0])));
  }
  if(command==='answer') {
    if(positionals.length!==1||flags.size!==1||!flags.has('choice'))
      throw new Error('Usage: suno answer <run-dir> --choice <ready|cancel>');
    return answerOrchestration(positionals[0],flags.get('choice')!);
  }
  if(command==='reconcile') {
    if(positionals.length!==2||flags.size!==2||!flags.has('reason')||!flags.has('result-json'))
      throw new Error('Usage: suno reconcile <run-dir> <command-key> --result-json <file> --reason <text>');
    const value=JSON.parse(await readFile(resolve(flags.get('result-json')!),'utf8'));
    return reconcileOrchestration(positionals[0],positionals[1],value,flags.get('reason')!);
  }
  if(command==='repair-tail') {
    if(positionals.length!==1||flags.size!==1||!flags.has('reason'))
      throw new Error('Usage: suno repair-tail <run-dir> --reason <text>');
    return repairOrchestrationTail(positionals[0],flags.get('reason')!);
  }
  throw new Error('Usage: suno <validate|login|inspect-site|create|status|check|resume|answer|reconcile|repair-tail> ...');
}
export async function main(argv=process.argv.slice(2)):Promise<void> {
  try {
    const value=await execute(argv);
    process.stdout.write(JSON.stringify(value)+'\n');
    if(['create','resume'].includes(argv[0])) {
      const report=value as OrchestrationReport;
      if(report.status!=='completed'||(report.result as {status?:string}|undefined)?.status!=='ready')
        process.exitCode=report.status==='completed'?2:1;
    }
    if(argv[0]==='check' && (value as {status?:string}).status!=='ready') process.exitCode=2;
  } catch(error) {
    process.stdout.write(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)})+'\n');
    process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
