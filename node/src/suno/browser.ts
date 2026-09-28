import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ensureDirectoryNoLinks } from '../workflow/paths.js';
import type { SunoSong } from './input.js';

const execFileAsync = promisify(execFile);
const createUrl = 'https://suno.com/create';
type BrowserReply = {success:boolean; data?: Record<string,unknown>; error?:string};
type Ref = {name?:string;role?:string};
type Snapshot = {refs:Record<string,Ref>};
type PageState = {url:string; state:'login_required'|'form_ready'|'unknown';
  trackUrls:string[]; matchingUrls:string[]; blocker?:string};

export function sunoProfileDirectory(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('LOCALAPPDATA is required for the dedicated Suno browser profile');
  return resolve(local,'DesktopPilot','suno-profile');
}

function songUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url=new URL(value);return url.origin==='https://suno.com' && /^\/song\/[A-Za-z0-9-]+\/?$/.test(url.pathname); }
  catch { return false; }
}

/** Uses the installed agent-browser executable; no page API or private Suno endpoint is invoked. */
export class SunoBrowser {
  private readonly profile:string;
  private readonly session:string;
  private readonly executable:string;
  private readonly edge:string;
  constructor(profileDirectory = sunoProfileDirectory(),
    private readonly run: (exe:string,args:string[])=>Promise<BrowserReply> = SunoBrowser.runCommand) {
    this.profile=resolve(profileDirectory);
    this.session=`dp-suno-${createHash('sha256').update(this.profile.toLowerCase()).digest('hex').slice(0,12)}`;
    this.executable=process.env.DP_AGENT_BROWSER_EXE ?? resolve(process.env.APPDATA ?? '',
      'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
    this.edge=process.env.DP_EDGE_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  }
  static async runCommand(exe:string,args:string[]):Promise<BrowserReply> {
    let stdout:string;
    try {({stdout}=await execFileAsync(exe,args,{windowsHide:true,timeout:45_000,maxBuffer:2_000_000}));}
    catch(error) {
      const failure=error as Error & {stdout?:string};
      try {const parsed=JSON.parse(failure.stdout??'') as BrowserReply;
        throw new Error(`Browser command failed: ${parsed.error ?? 'unknown error'}`);}
      catch(parsed) {if(parsed instanceof Error && parsed.message.startsWith('Browser command failed:')) throw parsed;}
      throw new Error(`Browser command failed: ${failure.message.split('\n')[0]}`);
    }
    const reply=JSON.parse(stdout) as BrowserReply;
    if (!reply.success) throw new Error(`Browser command failed: ${reply.error ?? 'unknown error'}`);
    return reply;
  }
  private async command(...args:string[]):Promise<Record<string,unknown>> {
    if (!existsSync(this.executable)) throw new Error(`agent-browser executable is missing: ${this.executable}`);
    if (!existsSync(this.edge)) throw new Error(`Microsoft Edge executable is missing: ${this.edge}`);
    await ensureDirectoryNoLinks(this.profile);
    const result=await this.run(this.executable,[
      '--session',this.session,'--profile',this.profile,'--executable-path',this.edge,'--json',...args]);
    if (!result.success) throw new Error(`Browser command failed: ${result.error ?? 'unknown error'}`);
    return result.data ?? {};
  }
  async openLogin():Promise<void> {
    // Reopen an earlier headless inspection session as a visible browser for manual sign-in.
    await this.command('close');
    await this.command('--headed','open',createUrl);
  }
  async close():Promise<void> {
    await this.command('close');
  }
  private async currentUrl():Promise<string> {
    const result=await this.command('get','url');
    return String(result.url ?? '');
  }
  private async openCreate():Promise<void> {
    if (!(await this.currentUrl()).startsWith(createUrl)) await this.command('open',createUrl);
  }
  private async snapshot():Promise<Snapshot> {
    const result=await this.command('snapshot','-i');
    return {refs:(result.refs ?? {}) as Record<string,Ref>};
  }
  private async readPage(title=''):Promise<PageState> {
    const expression=`(() => {
      const text = document.body?.innerText || '';
      const url = location.href;
      const links = [...document.querySelectorAll('a[href]')].map(a => {
        const href = new URL(a.getAttribute('href'),location.href).href;
        const card = a.closest('article,li,[data-testid]') || a.parentElement?.parentElement;
        return {url:href,label:(card?.innerText || a.innerText || '').slice(0,500)};
      }).filter(x => /^https:\\/\\/suno\\.com\\/song\\/[A-Za-z0-9-]+\\/?$/.test(x.url));
      const login = [...document.querySelectorAll('button,a')].some(x =>
        /^(log in|sign in|登录)$/i.test((x.textContent||'').trim()));
      const custom = [...document.querySelectorAll('button,[role=tab],[role=radio]')].some(x =>
        /^(custom|自定义)$/i.test((x.textContent||x.getAttribute('aria-label')||'').trim()));
      const blocker = /(?:not enough credits|insufficient credits|积分不足)/i.test(text) ? 'insufficient_credits' :
        /(?:verify you are human|captcha|人机验证)/i.test(text) ? 'human_verification' : undefined;
      return {url,login,custom,blocker,links};
    })()`;
    const result=await this.command('eval',expression);
    const data=result.result as {url?:string;login?:boolean;custom?:boolean;blocker?:string;
      links?:Array<{url:string;label:string}>} | undefined;
    if (!data || typeof data.url!=='string') throw new Error('Suno page inspection returned no URL');
    const links=(data.links??[]).filter(link=>songUrl(link.url));
    const trackUrls=[...new Set(links.map(link=>link.url))];
    const matchingUrls=title ? [...new Set(links.filter(link=>link.label.includes(title)).map(link=>link.url))] : [];
    const state=data.login ? 'login_required' :
      data.url.startsWith(createUrl) && data.custom ? 'form_ready' : 'unknown';
    return {url:data.url,state,trackUrls,matchingUrls,...(data.blocker?{blocker:data.blocker}:{})};
  }
  async inspect():Promise<PageState> {
    await this.openCreate();
    return this.readPage();
  }
  private uniqueRef(snapshot:Snapshot,role:string,name:RegExp):string {
    const found=Object.entries(snapshot.refs).filter(([,ref])=>ref.role===role && name.test(ref.name??''));
    if (found.length!==1) throw new Error(`Suno form layout changed: expected one ${role} matching ${name}; found ${found.length}`);
    return `@${found[0][0]}`;
  }
  private async field(name:RegExp):Promise<string> {
    return this.uniqueRef(await this.snapshot(),'textbox',name);
  }
  private async readValue(ref:string):Promise<string> {
    const result=await this.command('get','value',ref);
    return String(result.value ?? '').replaceAll('\r\n','\n');
  }
  private async verifyFields(song:SunoSong):Promise<void> {
    for (const [pattern,value] of [
      [/lyrics|歌词/i,song.lyrics],[/styles?|风格|曲风/i,song.style],[/title|歌名|标题/i,song.title]
    ] as const) {
      const ref=await this.field(pattern);
      if ((await this.readValue(ref)).trim()!==value.trim())
        throw new Error(`Suno form readback did not match ${pattern}`);
    }
  }
  async prepare(song:SunoSong):Promise<{status:'prepared'}> {
    const page=await this.inspect();
    if (page.state==='login_required') throw new Error('Suno login is required in the dedicated browser profile');
    if (page.blocker) throw new Error(`Suno is blocked: ${page.blocker}`);
    let tree=await this.snapshot();
    const hasLyrics=Object.values(tree.refs).some(ref=>ref.role==='textbox' && /lyrics|歌词/i.test(ref.name??''));
    if (!hasLyrics) {
      const custom=Object.entries(tree.refs).filter(([,ref])=>
        ['button','tab','radio','switch'].includes(ref.role??'') && /^(custom|自定义)$/i.test(ref.name??''));
      if (custom.length!==1) throw new Error('Suno Custom mode control is unavailable or ambiguous');
      await this.command('click',`@${custom[0][0]}`);
      tree=await this.snapshot();
    }
    for (const [pattern,value] of [
      [/lyrics|歌词/i,song.lyrics],[/styles?|风格|曲风/i,song.style],[/title|歌名|标题/i,song.title]
    ] as const) {
      const ref=this.uniqueRef(tree,'textbox',pattern);
      await this.command('fill',ref,value);
      tree=await this.snapshot();
    }
    await this.verifyFields(song);
    const submit=this.uniqueRef(await this.snapshot(),'button',/^(create|创建|生成)$/i);
    const enabled=await this.command('is','enabled',submit);
    if (enabled.enabled===false) throw new Error('Suno Create button is disabled');
    return {status:'prepared'};
  }
  async submit(song:SunoSong,baselineUrls:string[]):Promise<{status:'submitted';trackUrls:string[]}> {
    if (baselineUrls.some(url=>!songUrl(url))) throw new Error('Invalid Suno baseline song URL');
    await this.verifyFields(song);
    const before=await this.readPage(song.title);
    const known=new Set([...baselineUrls,...before.trackUrls]);
    const submit=this.uniqueRef(await this.snapshot(),'button',/^(create|创建|生成)$/i);
    await this.command('click',submit);
    const deadline=Date.now()+30_000;
    do {
      const page=await this.readPage(song.title);
      const fresh=page.matchingUrls.filter(url=>!known.has(url));
      if (fresh.length) return {status:'submitted',trackUrls:fresh};
      if (page.blocker) throw new Error(`Suno rejected or interrupted submission: ${page.blocker}; inspect before retrying`);
      await delay(2_000);
    } while(Date.now()<deadline);
    throw new Error('Suno Create was clicked but no new matching song link appeared; outcome is uncertain');
  }
  private async trackReady(url:string):Promise<'ready'|'pending'|'failed'> {
    if (!songUrl(url)) throw new Error(`Invalid Suno song URL: ${url}`);
    await this.command('open',url);
    const result=await this.command('eval',`(() => {
      const text=document.body?.innerText || '';
      const playable=[...document.querySelectorAll('button')].some(b =>
        !b.disabled && /^(play|播放)$/i.test((b.getAttribute('aria-label')||b.title||b.textContent||'').trim()));
      const audio=!!document.querySelector('audio[src],audio source[src]');
      const failed=/(?:generation failed|couldn't generate|生成失败)/i.test(text);
      const pending=/(?:generating|processing|queued|正在生成|排队中)/i.test(text);
      return {url:location.href,playable,audio,failed,pending};
    })()`);
    const data=result.result as {url?:string;playable?:boolean;audio?:boolean;failed?:boolean;pending?:boolean}|undefined;
    if (!data || !songUrl(data.url) || new URL(data.url).pathname!==new URL(url).pathname)
      throw new Error('Suno song page did not retain the expected identity');
    if (data.failed) return 'failed';
    return (data.audio || (data.playable && !data.pending)) ? 'ready' : 'pending';
  }
  async wait(trackUrls:string[],timeoutMs:number):Promise<{status:'ready'|'pending';trackUrls:string[]}> {
    if (!trackUrls.length || trackUrls.some(url=>!songUrl(url))) throw new Error('Suno wait requires song URLs');
    const deadline=Date.now()+timeoutMs;
    do {
      const states=[];
      for (const url of trackUrls) states.push(await this.trackReady(url));
      if (states.includes('failed')) throw new Error('Suno reported generation failure for a submitted song');
      if (states.every(state=>state==='ready')) return {status:'ready',trackUrls};
      if (Date.now()+3_000>=deadline) break;
      await delay(3_000);
    } while(Date.now()<deadline);
    return {status:'pending',trackUrls};
  }
}
