import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { JsonObject } from '../native/client.js';

const obj=(value:unknown):JsonObject=>value && typeof value==='object' && !Array.isArray(value)
  ?value as JsonObject:{};

/** Opt-in, write-ahead record of semantic desktop input for later draft export. */
export class ReplayRecorder {
  private readonly windows=new Map<string,{title:string;pid?:number}>();
  private tail:Promise<unknown>=Promise.resolve();
  private constructor(readonly path:string) {}

  static async create(directory:string):Promise<ReplayRecorder> {
    await mkdir(directory,{recursive:true});
    const path=join(resolve(directory),`agent-${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}.jsonl`);
    const file=await open(path,'wx');await file.close();
    return new ReplayRecorder(path);
  }

  observe(tool:string,args:JsonObject,result:JsonObject):void {
    if (result.status!=='ok') return;
    if (tool==='list_windows' && Array.isArray(result.windows)) {
      this.windows.clear();
      for (const raw of result.windows) {
        const item=obj(raw),id=String(item.window_id??'');
        if (id) this.windows.set(id,{title:String(item.title??''),
          ...(typeof item.pid==='number'?{pid:item.pid}:{})});
      }
    } else if (tool==='get_window_state') {
      const id=String(args.window_id??''),title=String(result.title??'');
      if (id && title) this.windows.set(id,{title,...(this.windows.get(id)?.pid?{pid:this.windows.get(id)!.pid}:{})});
    }
  }

  async intent(tool:string,args:JsonObject):Promise<string> {
    const id=randomUUID(),windowId=String(args.window_id??'');
    await this.append({kind:'intent',id,tool,target:this.windows.get(windowId)??null,args});
    return id;
  }

  async receipt(id:string,result:JsonObject):Promise<void> {
    await this.append({kind:'receipt',id,result});
  }

  private append(entry:JsonObject):Promise<void> {
    const line=JSON.stringify({time:new Date().toISOString(),...entry})+'\n';
    if (line.length>2_000_000) throw new Error('Replay recording entry exceeds 2 MB');
    const next=this.tail.then(async()=>{
      const file=await open(this.path,'a');
      try {await file.writeFile(line);await file.sync();} finally {await file.close();}
    });
    this.tail=next.catch(()=>undefined);
    return next;
  }
}
