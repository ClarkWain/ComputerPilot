import { randomUUID } from 'node:crypto';
import { open, readFile, unlink, mkdir, rmdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stableJson } from './plan.js';

export type WorkflowEvent = { seq: number; time: string; kind: string; [key: string]: unknown };

export async function acquireRunLock(runDirectory: string): Promise<() => Promise<void>> {
  const path = join(resolve(runDirectory), '.run.lock');
  const token = randomUUID();
  for (let attempt=0; attempt<2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); await file.sync(); }
      finally { await file.close(); }
      return async () => {
        try {
          const owner=JSON.parse(await readFile(path,'utf8')) as {token?:string};
          if (owner.token===token) await unlink(path);
        } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
      let owner:{pid?:number;token?:string};
      try { owner=JSON.parse(await readFile(path,'utf8')) as typeof owner; }
      catch { throw new Error(`Workflow run lock is busy or damaged: ${path}`); }
      if (!Number.isInteger(owner.pid) || !owner.token) throw new Error(`Workflow run lock is damaged: ${path}`);
      try { process.kill(owner.pid!,0); throw new Error(`Workflow run is active in process ${owner.pid}`); }
      catch (check) {
        if ((check as NodeJS.ErrnoException).code!=='ESRCH') throw check;
        const guard=path+'.recovery';
        try { await mkdir(guard); } catch { throw new Error(`Workflow run lock recovery is in progress: ${guard}`); }
        try {
          const current=JSON.parse(await readFile(path,'utf8')) as {pid?:number;token?:string};
          if (current.token!==owner.token) throw new Error('Workflow run lock changed during recovery');
          await unlink(path);
        } finally { await rmdir(guard); }
      }
    }
  }
  throw new Error(`Unable to acquire workflow run lock: ${path}`);
}

export async function isRunLockActive(runDirectory:string):Promise<boolean> {
  try {
    const owner=JSON.parse(await readFile(join(resolve(runDirectory),'.run.lock'),'utf8')) as {pid?:number;token?:string};
    if (!Number.isInteger(owner.pid)||!owner.token) return false;
    try { process.kill(owner.pid!,0); return true; }
    catch(error) { return (error as NodeJS.ErrnoException).code!=='ESRCH'; }
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;
    return false;
  }
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temp=`${path}.${process.pid}.${randomUUID()}.tmp`;
  const file=await open(temp,'wx',0o600);
  try { await file.writeFile(JSON.stringify(value,null,2)+'\n'); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temp,path); }
  catch (error) { try { await unlink(temp); } catch { /* keep original error */ } throw error; }
}

export async function readWorkflowEvents(runDirectory: string): Promise<WorkflowEvent[]> {
  const source=await readFile(join(resolve(runDirectory),'execution.jsonl'),'utf8');
  if (!source.endsWith('\n')) throw new Error('Workflow journal ends with an incomplete event; reconciliation is required');
  const lines=source.split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines.length>1_000_000) throw new Error('Workflow journal event count is invalid');
  const events:WorkflowEvent[]=[];
  for (let index=0;index<lines.length;index++) {
    let event:unknown;
    try { event=JSON.parse(lines[index]); } catch { throw new Error(`Workflow journal event ${index+1} is invalid JSON`); }
    if (!event || typeof event!=='object' || Array.isArray(event)) throw new Error(`Workflow journal event ${index+1} is not an object`);
    const item=event as WorkflowEvent;
    if (item.seq!==index+1 || typeof item.kind!=='string' || typeof item.time!=='string')
      throw new Error(`Workflow journal sequence is invalid at event ${index+1}`);
    events.push(item);
  }
  return events;
}

/** Called only under the run lock and only for explicit reconciliation. Preserves the undecodable tail. */
export async function preserveAndTruncateIncompleteTail(runDirectory:string):Promise<boolean> {
  const path=join(resolve(runDirectory),'execution.jsonl');
  const bytes=await readFile(path);
  if (bytes.length===0||bytes.at(-1)===10) return false;
  const lastNewline=bytes.lastIndexOf(10);
  if (lastNewline<0) throw new Error('Workflow journal has no complete event to recover');
  const tail=bytes.subarray(lastNewline+1);
  const backup=join(resolve(runDirectory),`journal-incomplete-${Date.now()}-${randomUUID()}.bin`);
  const backupFile=await open(backup,'wx',0o600);
  try { await backupFile.writeFile(tail); await backupFile.sync(); } finally { await backupFile.close(); }
  const journal=await open(path,'r+');
  try { await journal.truncate(lastNewline+1); await journal.sync(); } finally { await journal.close(); }
  return true;
}

export class WorkflowJournal {
  private constructor(private readonly path:string,private readonly file:Awaited<ReturnType<typeof open>>,private seq:number) {}
  static async create(runDirectory:string):Promise<WorkflowJournal> {
    const path=join(resolve(runDirectory),'execution.jsonl');
    const file=await open(path,'wx',0o600);
    return new WorkflowJournal(path,file,0);
  }
  static async appendExisting(runDirectory:string):Promise<WorkflowJournal> {
    const path=join(resolve(runDirectory),'execution.jsonl');
    const events=await readWorkflowEvents(runDirectory);
    const file=await open(path,'a',0o600);
    return new WorkflowJournal(path,file,events.length);
  }
  async append(event:Omit<WorkflowEvent,'seq'|'time'|'kind'> & {kind:string}):Promise<WorkflowEvent> {
    const stored:WorkflowEvent={seq:++this.seq,time:new Date().toISOString(),...event};
    const line=stableJson(stored)+'\n';
    if (Buffer.byteLength(line)>2_000_000) { this.seq--; throw new Error('Workflow journal event exceeds 2 MB'); }
    try { await this.file.writeFile(line); await this.file.sync(); }
    catch(error) { this.seq--; throw error; }
    return stored;
  }
  async close():Promise<void> { await this.file.close(); }
}

export async function readControlRequest(runDirectory:string):Promise<'pause'|'cancel'|undefined> {
  try {
    const value=JSON.parse(await readFile(join(resolve(runDirectory),'control.json'),'utf8')) as {request?:unknown};
    return value.request==='pause'||value.request==='cancel'?value.request:undefined;
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return undefined;
    throw new Error(`Workflow control request is invalid: ${String(error)}`);
  }
}

/** Consume a prior boundary request while holding the run lock and the short control lock. */
export async function consumeControlRequest(runDirectory:string):Promise<'pause'|'cancel'|undefined> {
  const root=resolve(runDirectory),guard=join(root,'control.lock');
  await mkdir(guard);
  try {
    const request=await readControlRequest(root);
    try { await unlink(join(root,'control.json')); }
    catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    return request;
  } finally { await rmdir(guard); }
}
