import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { NativeCallError, type JsonObject, type NativeCallOptions } from '../native/client.js';
import type { ProfileEngine } from '../profiles/engine.js';

type NativeGateway = { generation: number; call(operation: string, args?: JsonObject, options?: NativeCallOptions): Promise<JsonObject> };
type Observation = { window: JsonObject; capture?: JsonObject; controls: Map<string, JsonObject>; generation: number };
type StateBaseline = { generation: number; view: string; window: JsonObject; result: JsonObject;
  controls: Map<string, JsonObject>; captureHash?: string };
const obj = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const num = (value: unknown): number => typeof value === 'number' ? value : 0;
export const operationFailed = (value: JsonObject): boolean => ['error','failed','timeout','partial'].includes(str(value.status)) ||
  value.verification === 'failed' || value.referencesInvalidated === true;
const failed = operationFailed;
const invalid = (message: string): never => { throw new Error(message); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function changedFields(before: JsonObject, after: JsonObject, excluded: string[] = []): JsonObject {
  const set: JsonObject = {}; const unset: string[] = [];
  for (const key of Object.keys(after)) if (!excluded.includes(key) && !same(before[key], after[key])) set[key] = after[key];
  for (const key of Object.keys(before)) if (!excluded.includes(key) && !(key in after)) unset.push(key);
  return { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
}
function controlIdentity(value: JsonObject, kind: 'ref' | 'automation' | 'exact' | 'bounds'): string {
  const role = str(value.role), bounds = JSON.stringify(value.bounds ?? null);
  if (kind === 'ref') return str(value.elementRef) ? role+'|'+str(value.elementRef) : '';
  if (kind === 'automation') return str(value.automationId) ? role+'|'+str(value.automationId) : '';
  return kind === 'exact' ? role+'|'+str(value.name)+'|'+bounds : role+'|'+bounds;
}
function semanticForComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticForComparison);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['metrics','visited'].includes(key))
    .map(([key,item]) => [key,semanticForComparison(item)]));
}
async function removeUnreturnedCapture(capture: JsonObject): Promise<void> {
  for (const key of ['path','originalPath']) {
    const path=str(capture[key]);
    if (path && dirname(resolve(path))===resolve(tmpdir()) &&
      basename(path).startsWith('desktop-pilot-observe-')) {
      try { await unlink(path); } catch { /* Capture may already be gone. */ }
    }
  }
}
async function changedImagePatch(before: JsonObject, after: JsonObject): Promise<JsonObject | 'same' | undefined> {
  const oldPath=str(before.path),newPath=str(after.path);
  const width=num(after.width),height=num(after.height);
  if (!oldPath || !newPath || width<1 || height<1 || width!==num(before.width) ||
    height!==num(before.height) || width*height>16_000_000) return undefined;
  try {
    const [oldImage,newImage]=await Promise.all([
      sharp(oldPath).ensureAlpha().raw().toBuffer({resolveWithObject:true}),
      sharp(newPath).ensureAlpha().raw().toBuffer({resolveWithObject:true})
    ]);
    if(oldImage.info.width!==width || oldImage.info.height!==height ||
      newImage.info.width!==width || newImage.info.height!==height ||
      oldImage.info.channels!==4 || newImage.info.channels!==4) return undefined;
    let left=width,top=height,right=-1,bottom=-1;
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const offset=(y*width+x)*4;
      if(oldImage.data[offset]!==newImage.data[offset] ||
        oldImage.data[offset+1]!==newImage.data[offset+1] ||
        oldImage.data[offset+2]!==newImage.data[offset+2] ||
        oldImage.data[offset+3]!==newImage.data[offset+3]) {
        left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
      }
    }
    if(right<0)return 'same';
    const margin=8;
    const rect={x:Math.max(0,left-margin),y:Math.max(0,top-margin),
      width:Math.min(width-1,right+margin)-Math.max(0,left-margin)+1,
      height:Math.min(height-1,bottom+margin)-Math.max(0,top-margin)+1};
    if(rect.width*rect.height>width*height*0.35)return undefined;
    const webp=after.mimeType==='image/webp';
    const bytes=await sharp(newPath).extract({left:rect.x,top:rect.y,width:rect.width,height:rect.height})
      .toFormat(webp?'webp':'png').toBuffer();
    const path=newPath+'.delta.'+(webp?'webp':'png');
    await writeFile(path,bytes);
    return {kind:'patch',path,fullPath:newPath,rect,frame:{width,height},
      width:rect.width,height:rect.height,delivery:after.delivery,
      mimeType:webp?'image/webp':'image/png',
      imageRef:'img-sha256-'+createHash('sha256').update(bytes).digest('hex')};
  } catch { return undefined; }
}
const resultError = (code: string, message: string, next: string): JsonObject =>
  ({ status: 'error', code, message, dispatch: 'not_started', next });
function fields(value: unknown, allowed: string[]): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  const record = value as JsonObject;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) invalid(`Unknown field: ${key}`);
  return record;
}
function requiredText(value: JsonObject, key: string): string {
  const text = str(value[key]); if (!text) invalid(`Required nonempty string: ${key}`); return text;
}
function positiveInt(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || num(value) < min || num(value) > max) invalid(`${name} must be integer ${min}..${max}`);
  return value as number;
}
function keyChord(value: string): string[] {
  const aliases: Record<string, string> = { CONTROL: 'CTRL', CONTROL_L: 'CTRL', RETURN: 'ENTER', ESCAPE: 'ESC', DEL: 'DELETE', SPACEBAR: 'SPACE' };
  const named = new Set(['CTRL','ALT','SHIFT','WIN','ENTER','TAB','ESC','BACKSPACE','DELETE','HOME','END','LEFT','RIGHT','UP','DOWN','SPACE','PAGEUP','PAGEDOWN','INSERT']);
  const keys = value.split('+').map(x => x.trim().toUpperCase()).map(x => aliases[x] ?? x);
  if (keys.some(x => !x || !(named.has(x) || /^[A-Z0-9]$/.test(x) || /^F(?:[1-9]|1[0-2])$/.test(x)))) invalid(`Unsupported key chord: ${value}`);
  return keys;
}

export class AgentApi {
  private readonly targets = new Map<string, JsonObject>();
  private readonly observations = new Map<string, Observation>();
  private readonly baselines = new Map<string, StateBaseline>();
  private generation: number;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly native: NativeGateway, private readonly profiles: ProfileEngine) { this.generation = native.generation; }
  private syncGeneration(): void {
    if (this.generation !== this.native.generation) {
      this.targets.clear(); this.observations.clear(); this.baselines.clear(); this.generation = this.native.generation;
    }
  }
  private async dispatch(operation: string, args: JsonObject = {}, options: NativeCallOptions = {}): Promise<JsonObject> {
    const before = this.native.generation;
    try {
      const value = await this.native.call(operation, args, options);
      if (this.native.generation !== before) this.syncGeneration();
      if (value.referencesInvalidated) this.syncGeneration();
      return value;
    } catch (error) {
      this.syncGeneration();
      if (error instanceof NativeCallError) return error.toResult();
      throw error;
    }
  }
  private async prepareWindow(id: string, options: NativeCallOptions): Promise<JsonObject> {
    let window = await this.dispatch('window.get', { windowRef: id }, options);
    if (failed(window)) return window;
    if (window.enabled === false) {
      const popup = obj(window.blockingWindow);
      if (str(popup.windowRef)) this.targets.set(str(popup.windowRef), popup);
      return { ...resultError('window_blocked', 'Target is disabled; inspect its modal dialog.', 'Inspect blocking window'),
        ...(str(popup.windowRef) ? { blocking_window: { window_id: popup.windowRef, title: popup.title, pid: popup.pid } } : {}) };
    }
    if (!window.foreground || window.minimized) {
      const activation = await this.dispatch('window.activate', { windowRef: id }, options);
      if (failed(activation)) return activation;
      window = await this.dispatch('window.get', { windowRef: id }, options);
      if (failed(window)) return window;
      if (window.enabled === false) return resultError('window_blocked', 'Target became blocked during activation.', 'get_window_state with activate:false');
      if (!window.foreground) return resultError('window_activation_failed', 'Automatic activation did not restore target focus.', 'Inspect desktop and blocking window');
    }
    return window;
  }
  private geometryChanged(now: JsonObject, before: JsonObject): boolean {
    return ['bounds','dpi','client','display','dpiAwareness'].some(key => !same(now[key], before[key]));
  }
  private stabilizeControls(previous: StateBaseline, result: JsonObject, observation: Observation): void {
    const items = (result.controls as JsonObject[]) ?? [];
    const oldItems = (previous.result.controls as JsonObject[]) ?? [];
    const unmatchedOld = new Set(oldItems.map(item => str(item.control_id)));
    const matches = new Map<number, string>();
    for (const kind of ['ref','automation','exact','bounds'] as const) {
      const oldKeys = new Map<string, string[]>();
      const newKeys = new Map<string, number[]>();
      for (const id of unmatchedOld) {
        const key = controlIdentity(obj(previous.controls.get(id)),kind);
        if (key) oldKeys.set(key,[...(oldKeys.get(key) ?? []),id]);
      }
      for (let index=0;index<items.length;index++) {
        if (matches.has(index)) continue;
        const key = controlIdentity(obj(observation.controls.get(str(items[index].control_id))),kind);
        if (key) newKeys.set(key,[...(newKeys.get(key) ?? []),index]);
      }
      for (const [key,old] of oldKeys) {
        const current = newKeys.get(key);
        if (old.length===1 && current?.length===1) {
          matches.set(current[0],old[0]);unmatchedOld.delete(old[0]);
        }
      }
    }
    const reserved = new Set(oldItems.map(item => str(item.control_id)));
    const mapped = new Map<string, JsonObject>();
    for (let index=0;index<items.length;index++) {
      const item=items[index];const original=str(item.control_id);
      const raw=observation.controls.get(original);if(!raw)continue;
      let id=matches.get(index) ?? original;
      if (mapped.has(id) || (!matches.has(index) && reserved.has(id))) {
        do { id='d-'+randomUUID(); } while (mapped.has(id) || reserved.has(id));
      }
      item.control_id=id;mapped.set(id,raw);
    }
    observation.controls=mapped;
  }
  private async stateResult(id: string, mode: string, detail: string, delivery: string,
    maxEdge: unknown, region: unknown, changeMode: string, window: JsonObject,
    result: JsonObject, observation: Observation, signal?: AbortSignal): Promise<JsonObject> {
    const view=JSON.stringify({mode,detail,delivery,maxEdge:maxEdge ?? (region?32000:1600),region:region ?? null});
    const previous=this.baselines.get(id);
    const incomplete=mode!=='image' && (result.truncated===true || obj(result.inspection).status!=='ok' ||
      obj(result.semantic).status!=='ok');
    const canDiff=changeMode==='delta' && previous && previous.generation===this.native.generation &&
      previous.view===view && !this.geometryChanged(window,previous.window) && !incomplete;
    if (canDiff && mode!=='image') this.stabilizeControls(previous,result,observation);
    let captureHash: string|undefined;
    const capture=obj(result.capture);
    if (str(capture.path)) {
      const ref=str(capture.imageRef);
      if (/^img-sha256-[a-f0-9]{64}$/.test(ref)) captureHash=ref.slice('img-sha256-'.length);
      else {
        try { captureHash=createHash('sha256').update(await readFile(str(capture.path))).digest('hex'); }
        catch { /* A missing image cannot be treated as unchanged. */ }
      }
    }
    let unchangedCapture=Boolean(canDiff && captureHash && captureHash===previous?.captureHash);
    let patchCapture:JsonObject|undefined;
    if (canDiff && str(capture.path) && !unchangedCapture && previous.result.capture) {
      const visual=await changedImagePatch(obj(previous.result.capture),capture);
      if(visual==='same')unchangedCapture=true;
      else if(visual)patchCapture=visual;
    }
    if (signal?.aborted) return resultError('cancelled','Observation cancelled before delivery.','get_window_state');
    if (observation.generation!==this.native.generation) {
      this.syncGeneration();
      return {status:'error',code:'references_invalidated',referencesInvalidated:true,
        next:'list_windows; worker changed while preparing the observation'};
    }
    const storedResult=unchangedCapture?{...result,capture:previous!.result.capture}:result;
    if (incomplete) this.baselines.delete(id);
    else {
      this.baselines.delete(id);
      this.baselines.set(id,{generation:this.native.generation,view,window,result:storedResult,
        controls:new Map(observation.controls),captureHash});
      if (this.baselines.size>64) this.baselines.delete(this.baselines.keys().next().value!);
    }
    if (changeMode==='full') return result;
    if (!canDiff) {
      const reason=incomplete?'inspection_incomplete':!previous?'initial':
        previous.generation!==this.native.generation?'worker_changed':
        previous.view!==view?'view_changed':'geometry_changed';
      return {...result,change:{kind:'full',reason}};
    }
    const delta:JsonObject={status:'ok',window_id:id,change:{kind:'unchanged'}};
    const metadata=changedFields(previous.result,result,
      ['status','window_id','controls','semantic','capture','inspection','truncated','next']);
    if (Object.keys(metadata).length) delta.window=metadata;
    if (mode!=='image') {
      const oldItems=(previous.result.controls as JsonObject[]) ?? [];
      const newItems=(result.controls as JsonObject[]) ?? [];
      const oldById=new Map(oldItems.map(item=>[str(item.control_id),item]));
      const newById=new Map(newItems.map(item=>[str(item.control_id),item]));
      const added=newItems.filter(item=>!oldById.has(str(item.control_id)));
      const removed=oldItems.filter(item=>!newById.has(str(item.control_id))).map(item=>str(item.control_id));
      const updated=newItems.flatMap(item=>{
        const old=oldById.get(str(item.control_id));if(!old)return [];
        const patch=changedFields(old,item,['control_id']);
        return Object.keys(patch).length?[{control_id:item.control_id,...patch}]:[];
      });
      if (added.length||removed.length||updated.length) delta.controls={
        ...(added.length?{added}:{}),...(updated.length?{updated}:{}),...(removed.length?{removed}:{})};
      if (!same(semanticForComparison(previous.result.semantic),semanticForComparison(result.semantic)))
        delta.semantic=result.semantic;
      if (!same(semanticForComparison(previous.result.inspection),semanticForComparison(result.inspection)))
        delta.inspection=result.inspection;
      if (!same(previous.result.truncated,result.truncated)) delta.truncated=result.truncated;
    }
    if (str(capture.path) && !unchangedCapture)
      delta.capture=patchCapture??capture;
    if (unchangedCapture && str(capture.path)!==str(obj(previous!.result.capture).path))
      await removeUnreturnedCapture(capture);
    if (Object.keys(delta).length>3) delta.change={kind:'delta'};
    return delta;
  }
  call(tool: string, rawArgs: JsonObject, options: NativeCallOptions = {}): Promise<JsonObject> {
    const run=async()=>{
      const result=await this.perform(tool,rawArgs,options);
      if (tool==='get_window_state' && operationFailed(result) && typeof rawArgs.window_id==='string') {
        this.baselines.delete(rawArgs.window_id);
        this.observations.delete(rawArgs.window_id);
      }
      return result;
    };
    const next=this.tail.then(run,run);
    this.tail=next.catch(()=>undefined);
    return next;
  }
  private async perform(tool: string, rawArgs: JsonObject, options: NativeCallOptions): Promise<JsonObject> {
    try {
      this.syncGeneration();
      if (tool === 'list_windows') {
        fields(rawArgs, []);
        const value = await this.dispatch('window.list', {}, options); if (failed(value)) return value;
        const windows = Array.isArray(value.windows) ? value.windows.map(obj) : [];
        const candidates = windows.map(window => { const id = str(window.windowRef); if (id) this.targets.set(id, window);
          return { window_id: id, title: str(window.title), pid: window.pid }; });
        return { status: 'ok', windows: candidates, next: 'Read titles/pids to identify the intended window_id, then get_window_state. No activation occurred.' };
      }
      if (tool === 'get_window_state') return await this.getWindowState(rawArgs, options);
      if (tool === 'execute_semantic') return await this.executeSemantic(rawArgs, options);
      if (tool === 'execute_batch') return await this.executeBatch(rawArgs, options);
      return resultError('invalid_arguments', `Unknown tool: ${tool}`, 'Use one of the four public tools');
    } catch (error) {
      if (error instanceof NativeCallError) return error.toResult();
      return resultError('invalid_arguments', error instanceof Error ? error.message : String(error), 'Correct arguments; if state changed use get_window_state');
    }
  }
  private async getWindowState(raw: JsonObject, options: NativeCallOptions): Promise<JsonObject> {
    const a = fields(raw, ['window_id','mode','detail','image_delivery','max_edge','activate','region','change_mode']);
    const id = requiredText(a, 'window_id');
    if (!this.targets.has(id)) return resultError('unknown_window', 'Use a window_id returned by list_windows in this session.', 'list_windows');
    this.observations.delete(id);
    const mode = str(a.mode ?? 'controls'); if (!['controls','image','both'].includes(mode)) invalid('mode must be image, controls or both');
    const detail = str(a.detail ?? 'compact'); if (!['compact','full'].includes(detail)) invalid('detail must be compact or full');
    const delivery = str(a.image_delivery ?? 'path'); if (!['path','inline'].includes(delivery)) invalid('image_delivery must be path or inline');
    const changeMode = str(a.change_mode ?? 'full'); if (!['full','delta'].includes(changeMode)) invalid('change_mode must be full or delta');
    if (a.region && mode === 'controls') invalid('region requires mode:image or both');
    if (delivery === 'inline' && mode === 'controls') invalid('image_delivery:inline requires mode:image or both');
    if (a.max_edge !== undefined) { if (mode === 'controls') invalid('max_edge requires image/both'); positiveInt(a.max_edge,1,32000,'max_edge'); }
    if (a.activate !== undefined && typeof a.activate !== 'boolean') invalid('activate must be boolean');
    const window = a.activate === false ? await this.dispatch('window.get',{windowRef:id},options) : await this.prepareWindow(id, options);
    if (failed(window)) return window;
    const bounds = obj(window.bounds);
    const result: JsonObject = { status:'ok', window_id:id, title:str(window.title), foreground:Boolean(window.foreground),
      coordinateSpace:'window_relative_physical_pixels', size:{width:bounds.width,height:bounds.height},
      next:'Prefer execute_semantic if a profile matches; otherwise execute_batch. Inspect again to verify the result.' };
    if (window.client && window.display) result.layout = {clientDip96:obj(window.client).dip96, displayDpi:obj(window.display).dpi, dpiAwareness:window.dpiAwareness ?? 'unknown'};
    const observation: Observation = { window, controls:new Map(), generation:this.native.generation };
    let semantic: JsonObject = { status:'not_checked', profiles:[], unavailable:[], next:'Image-only observation skips UI Automation. Use controls/both to discover semantic actions, or execute_batch from this screenshot.' };
    if (mode !== 'image') {
      semantic = obj(await this.profiles.discover(id, { window, signal:options.signal }));
      if (failed(semantic) && semantic.referencesInvalidated) return semantic;
      const tree = semantic.inspection ? obj(semantic.inspection) : await this.dispatch('ui.tree',
        {windowRef:id, format:'compact', depth:6, limit:80, nodeBudget:1500, queryTimeoutMs:3000, providerTimeoutMs:5000},options);
      if (tree.referencesInvalidated) return tree;
      const treeFailed = failed(tree) || !Array.isArray(tree.elements);
      if (treeFailed && mode === 'controls') return { ...tree, status:'error', next:'UI inspection failed. Use get_window_state mode:image and execute_batch from visible evidence.' };
      const incomplete = tree.truncated === true || tree.has_more === true || tree.evidenceComplete === false || tree.stopReason === 'provider_timeout';
      result.controls=[]; result.truncated=treeFailed || Boolean(tree.truncated);
      const inspection: JsonObject = { status:treeFailed?'error':incomplete?'incomplete':'ok' };
      for (const key of ['stopReason','visited','truncated','has_more','evidenceComplete','metrics','message','code','providerError'])
        if (tree[key] !== undefined) inspection[key]=tree[key];
      result.inspection=inspection;
      if (treeFailed) result.next='UI inspection failed; screenshot remains available. Use execute_batch from visible evidence.';
      else if (incomplete) result.next='UI inspection is incomplete. Use mode:image if needed, then execute_batch from visible evidence.';
      for (const element of treeFailed?[]:(tree.elements as unknown[]).map(obj)) {
        const ref=str(element.elementRef); if (!ref) continue;
        if (!str(element.name) && ['Pane','Window'].includes(str(element.role))) continue;
        if ((result.controls as JsonObject[]).length >= (detail==='full'?400:80)) { result.truncated=true; break; }
        observation.controls.set(ref, element);
        const cap=(text:string,limit:number)=>text.length<=limit?text:text.slice(0,limit)+'…[+'+(text.length-limit)+']';
        const item:JsonObject={ control_id:ref,name:cap(str(element.name),detail==='compact'?128:256),role:str(element.role) };
        for (const key of ['value','enabled','offscreen']) if (element[key]!==undefined) {
          if (detail==='compact' && ((key==='value' && !element[key]) || (key==='enabled' && element[key]===true) || (key==='offscreen' && element[key]===false))) continue;
          item[key]=key==='value'&&typeof element[key]==='string'?cap(element[key] as string,detail==='compact'?256:2048):element[key];
        }
        const b=obj(element.bounds); if (element.bounds) item.bounds=[num(b.x)-num(bounds.x),num(b.y)-num(bounds.y),b.width,b.height];
        (result.controls as JsonObject[]).push(item);
      }
    }
    if (mode !== 'controls') {
      const region = a.region ? fields(a.region,['x','y','width','height']) : undefined;
      if (region) { positiveInt(region.x,0,Number.MAX_SAFE_INTEGER,'region.x');positiveInt(region.y,0,Number.MAX_SAFE_INTEGER,'region.y');
        positiveInt(region.width,1,Number.MAX_SAFE_INTEGER,'region.width');positiveInt(region.height,1,Number.MAX_SAFE_INTEGER,'region.height'); }
      const webp=process.env.DP_IMAGE_FORMAT==='webp';
      const captureArgs:JsonObject={windowRef:id,method:'screen',output:join(tmpdir(),`desktop-pilot-observe-${randomUUID()}.${webp?'webp':'png'}`),maxEdge:a.max_edge ?? (region?32000:1600)};
      if (region) { captureArgs.region=region;captureArgs.lossless=true; }
      const capture=await this.dispatch('capture.window',captureArgs,options);if(failed(capture))return capture;
      capture.delivery=delivery;result.capture=capture;observation.capture=capture;
      result.coordinateSpace='image_pixels';result.inputSize={width:capture.width,height:capture.height};
    }
    const after=await this.dispatch('window.get',{windowRef:id},options);if(failed(after))return after;
    if (this.geometryChanged(after,window)) return resultError('geometry_changed','Window geometry or DPI changed while observing.','get_window_state');
    delete semantic.inspection;result.semantic=semantic;
    const response=await this.stateResult(id,mode,detail,delivery,a.max_edge,a.region,changeMode,window,result,observation,options.signal);
    if (!failed(response)) this.observations.set(id,observation);
    return response;
  }

  private async executeSemantic(raw: JsonObject, options: NativeCallOptions): Promise<JsonObject> {
    const a=fields(raw,['window_id','profile','actions']);const id=requiredText(a,'window_id');
    if (!this.targets.has(id)) return resultError('unknown_window','Use a window_id returned by list_windows.','list_windows');
    if (!Array.isArray(a.actions) || a.actions.length<1 || a.actions.length>256) invalid('actions must contain 1..256 items');
    const actions=(a.actions as unknown[]).map(item=>{const v=fields(item,['action','args']);return {action:requiredText(v,'action'),args:fields(v.args,Object.keys(obj(v.args)))};});
    const window=await this.prepareWindow(id,options);if(failed(window))return window;
    this.observations.delete(id);
    // ProfileEngine owns matching, live evidence checks, and application action execution.
    const budget=AbortSignal.timeout(600000);
    const signal=options.signal?AbortSignal.any([options.signal,budget]):budget;
    return obj(await this.profiles.execute(id,a.profile===undefined?undefined:requiredText(a,'profile'),actions,{signal}));
  }

  private async executeBatch(raw: JsonObject, options: NativeCallOptions): Promise<JsonObject> {
    const a=fields(raw,['window_id','actions']);const id=requiredText(a,'window_id');
    const observation=this.observations.get(id);
    if (!observation || observation.generation!==this.native.generation)
      return resultError('state_required','Inspect this window before sending another input batch.','get_window_state');
    if (!Array.isArray(a.actions) || a.actions.length<1 || a.actions.length>256) invalid('actions must contain 1..256 items');
    const actions=(a.actions as unknown[]).map(obj);
    if (actions[0].type==='prepare_window') {
      if (actions.length!==1) invalid('prepare_window must be the only action; inspect the new layout before input');
      const action=fields(actions[0],['type','client_size','minimum_client_size']);
      const size=(rawSize:unknown)=>{const s=fields(rawSize,['width','height','unit']);if(s.unit!=='dip96')invalid('client size unit must be dip96');
        positiveInt(s.width,1,20000,'width');positiveInt(s.height,1,20000,'height');return s;};
      const preferred=size(action.client_size);const minimum=size(action.minimum_client_size??preferred);
      if (num(minimum.width)>num(preferred.width)||num(minimum.height)>num(preferred.height))invalid('minimum client size exceeds preferred size');
      const current=await this.prepareWindow(id,options);if(failed(current))return current;
      if (this.geometryChanged(current,observation.window)) return resultError('geometry_changed','Window changed since observation.','get_window_state');
      this.observations.delete(id);
      const prepared=await this.dispatch('window.prepare',{windowRef:id,width:preferred.width,height:preferred.height,minimumWidth:minimum.width,minimumHeight:minimum.height},options);
      prepared.next='get_window_state to inspect actual layout before further input';return prepared;
    }
    const bounds=obj(observation.window.bounds);const capture=observation.capture;
    const point=(rawPoint:unknown):JsonObject=>{const p=fields(rawPoint,['x','y']);
      const frame=capture??bounds;const x=positiveInt(p.x,0,Number.MAX_SAFE_INTEGER,'x');const y=positiveInt(p.y,0,Number.MAX_SAFE_INTEGER,'y');
      if(x>=num(frame.width)||y>=num(frame.height))invalid('Point is outside observed window; no screen coordinates accepted');return {x,y};};
    const mapPoint=(rawPoint:unknown):JsonObject=>{const p=point(rawPoint);if(!capture)return p;
      const area=obj(capture.bounds);const mapped:JsonObject={};
      for (const axis of ['x','y'] as const) {const extent=axis==='x'?'width':'height';const span=num(area[extent]);
        mapped[axis]=Math.min(span-1,Math.floor((num(p[axis])+0.5)*span/num(capture[extent])))+num(area[axis])-num(bounds[axis]);}
      return mapped;};
    type Step={delayMs:number;operation:string;args:JsonObject;control?:JsonObject};const steps:Step[]=[];
    for (const rawAction of actions) {
      const delayMs=rawAction.delay_ms===undefined?0:positiveInt(rawAction.delay_ms,0,10000,'delay_ms');
      const action={...rawAction};delete action.delay_ms;const type=requiredText(action,'type');
      const base:JsonObject={windowRef:id,autoActivate:true,coordinateSpace:'window_relative',expectedSize:{width:bounds.width,height:bounds.height}};
      let operation='';let args:JsonObject=base;let control:JsonObject|undefined;
      if (action.control_id!==undefined) {const ref=requiredText(action,'control_id');control=observation.controls.get(ref);if(!control)invalid('control_id must come from last observation');}
      if (type==='click') {
        fields(action,['type','point','control_id','count']);if(Boolean(action.point)===Boolean(action.control_id))invalid('click needs exactly one of point/control_id');
        const count=action.count===undefined?1:positiveInt(action.count,1,2,'count');
        if(control){const selected=control;const b=obj(selected.bounds);args={...base,x:num(b.x)+Math.floor(num(b.width)/2)-num(bounds.x),y:num(b.y)+Math.floor(num(b.height)/2)-num(bounds.y),count};
          if(count===1){operation='ui.click';args={windowRef:id,elementRef:selected.elementRef};}}
        else args={...base,...mapPoint(action.point),count};
        if(!operation)operation='input.click';
      } else if(type==='fill_text'||type==='type_text') {
        fields(action,type==='fill_text'?['type','control_id','text']:['type','text']);if(typeof action.text!=='string')invalid('text must be a string');
        if(type==='fill_text'){if(!control)invalid('fill_text requires observed control_id');operation='ui.fill';args={windowRef:id,autoActivate:true,elementRef:control!.elementRef,text:action.text,timeoutMs:3000};}
        else{operation='input.type_text';args={...base,text:action.text};}
      } else if(type==='press_keys') {
        fields(action,['type','chord']);operation='input.key_chord';args={...base,keys:keyChord(requiredText(action,'chord'))};
      } else if(type==='drag') {
        fields(action,['type','from','to']);operation='input.drag';const from=mapPoint(action.from),to=mapPoint(action.to);
        args={...base,...from,toX:to.x,toY:to.y};
      } else if(type==='move') {
        fields(action,['type','points','hold']);if(!Array.isArray(action.points)||action.points.length<1||action.points.length>4096)invalid('move.points must contain 1..4096 [x,y] pairs');
        const points=(action.points as unknown[]).map((raw:unknown)=>{if(!Array.isArray(raw)||raw.length!==2)invalid('move point must be [x,y]');const pair=raw as unknown[];const p=mapPoint({x:pair[0],y:pair[1]});return [p.x,p.y];});
        if(action.hold!==undefined && !['left','right','middle'].includes(str(action.hold)))invalid('move.hold must be left, right or middle');
        if(action.hold && points.length<2)invalid('Held move needs at least two points');
        operation='input.move';args={...base,points,...(action.hold?{hold:action.hold}:{})};
      } else invalid(`Unknown action type: ${type}`);
      steps.push({delayMs,operation,args,control});
    }
    this.observations.delete(id);
    let completed=0,fieldsVerified=0;
    for (const step of steps) {
      let attempted=false;let response:JsonObject={};
      if(step.delayMs) await new Promise(resolve=>setTimeout(resolve,step.delayMs));
      if(options.signal?.aborted) response=resultError('cancelled','Batch cancelled before next action.','Inspect current state');
      else {
        const window=await this.prepareWindow(id,options);
        if(failed(window))response=window;
        else if(this.geometryChanged(window,observation.window))response=resultError('geometry_changed','Window geometry or DPI changed since observation.','get_window_state');
        else {
          if(step.control){const current=await this.dispatch('ui.get',{elementRef:step.control.elementRef},options);
            if(failed(current))response=current;
            else if(!same(current.bounds,step.control.bounds))response=resultError('control_changed','Control moved since observation.','get_window_state');}
          if(!failed(response)){attempted=true;response=await this.dispatch(step.operation,step.args,options);}
        }
      }
      if(failed(response)) return {status:'error',code:'action_failed',completed,failedIndex:completed,
        dispatch:response.dispatch??(attempted?'unknown':'not_started'),error:response,
        ...(response.referencesInvalidated?{referencesInvalidated:true}:{}),
        next:response.referencesInvalidated?response.next:'get_window_state; inspect failed action outcome before submitting only unfinished actions. No rollback.'};
      if(step.operation==='ui.fill')fieldsVerified++;completed++;
    }
    return {status:'ok',completed,fieldsVerified,verification:'business_result_not_verified',
      next:'get_window_state to verify the requested outcome; previous observation is consumed'};
  }
}
