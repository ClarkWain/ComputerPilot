import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';

export type ReplayAction = { action: string; args: Record<string, unknown> };
export type ReplayControlCondition = { name: string; role?: string; value?: string };
export type ReplayImageSample = { x: number; y: number; rgb: [number,number,number]; tolerance?: number };
export type ReplayImageReference = { asset: string; channelTolerance: number; maxChangedPercent: number };
export type ReplayCapture = { anchor: { nameContains: string; role: string; inset: { x:number; y:number; unit:'dip96'|'pixels' } };
  width:number; height:number; reference?:ReplayImageReference; savePath?:string };
export type ReplayCondition = { profileAvailable?: string; titleContains?: string;
  control?: ReplayControlCondition;
  file?: { path: string; sha256?: string; minBytes?: number; width?: number; height?: number;
    samples?: ReplayImageSample[];
    reference?: ReplayImageReference };
  capture?: ReplayCapture;
  fileAbsent?: string };
export type ReplayStep = { id: string; profile: string; action?: ReplayAction; actions?: ReplayAction[];
  before?: ReplayCondition; expect: ReplayCondition; settleTimeoutMs?: number;
  settle?: { mode:'image'; quietMs:number; pollMs:number; timeoutMs:number } };
export type ReplayRecipe = { schemaVersion: 1; name: string;
  target: { titleContains: string; pid?: number }; assets?: Array<{path:string;sha256:string}>; steps: ReplayStep[] };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}`);
};
const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text`);
  return value;
};
const safeRelative = (value: unknown, label: string): string => {
  const path = nonempty(value, label);
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\0'))
    throw new Error(`${label} must be a relative path inside the recipe directory`);
  return path;
};
function validateReference(raw:unknown,label:string):void {
  if (!record(raw)) throw new Error(`${label} must be an object`);
  keys(raw,['asset','channelTolerance','maxChangedPercent']);
  const asset=safeRelative(raw.asset,`${label}.asset`);
  if (!asset.replaceAll('\\','/').startsWith('assets/')) throw new Error(`${label}.asset must be under assets/`);
  if (!Number.isInteger(raw.channelTolerance) || Number(raw.channelTolerance)<0 || Number(raw.channelTolerance)>255)
    throw new Error(`${label}.channelTolerance must be 0..255`);
  if (typeof raw.maxChangedPercent!=='number' || !Number.isFinite(raw.maxChangedPercent) ||
    raw.maxChangedPercent<0 || raw.maxChangedPercent>100)
    throw new Error(`${label}.maxChangedPercent must be 0..100`);
}
export function validateCondition(raw: unknown, label: string, required: boolean): void {
  if (!record(raw)) throw new Error(`${label} must be an object`);
  keys(raw,['profileAvailable','titleContains','control','file','fileAbsent','capture']);
  if (required && !Object.keys(raw).length) throw new Error(`${label} needs an observable condition`);
  for (const key of ['profileAvailable','titleContains']) if (raw[key] !== undefined)
    nonempty(raw[key],`${label}.${key}`);
  if (raw.control !== undefined) {
    if (!record(raw.control)) throw new Error(`${label}.control must be an object`);
    keys(raw.control,['name','role','value']);
    nonempty(raw.control.name,`${label}.control.name`);
    if (raw.control.role !== undefined) nonempty(raw.control.role,`${label}.control.role`);
    if (raw.control.value !== undefined && typeof raw.control.value !== 'string')
      throw new Error(`${label}.control.value must be text`);
  }
  if (raw.fileAbsent !== undefined) safeRelative(raw.fileAbsent,`${label}.fileAbsent`);
  if (raw.file !== undefined) {
    if (!record(raw.file)) throw new Error(`${label}.file must be an object`);
    keys(raw.file, ['path','sha256','minBytes','width','height','samples','reference']);
    safeRelative(raw.file.path, `${label}.file.path`);
    if (raw.file.sha256 !== undefined &&
      (typeof raw.file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.file.sha256)))
      throw new Error(`${label}.file.sha256 must be a SHA-256 hex digest`);
    for (const key of ['minBytes','width','height']) if (raw.file[key] !== undefined &&
      (!Number.isInteger(raw.file[key]) || Number(raw.file[key]) < 1))
      throw new Error(`${label}.file.${key} must be positive`);
    if (raw.file.samples !== undefined) {
      if (!Array.isArray(raw.file.samples) || raw.file.samples.length<1 || raw.file.samples.length>100)
        throw new Error(`${label}.file.samples must contain 1..100 points`);
      for (const sample of raw.file.samples) {
        if (!record(sample)) throw new Error(`${label}.file.samples item must be an object`);
        keys(sample,['x','y','rgb','tolerance']);
        for (const key of ['x','y']) if (!Number.isInteger(sample[key]) || Number(sample[key])<0)
          throw new Error(`${label}.file.samples.${key} must be nonnegative`);
        if (!Array.isArray(sample.rgb) || sample.rgb.length!==3 ||
          sample.rgb.some(channel=>!Number.isInteger(channel) || channel<0 || channel>255))
          throw new Error(`${label}.file.samples.rgb must contain three 0..255 channels`);
        if (sample.tolerance!==undefined && (!Number.isInteger(sample.tolerance) ||
          Number(sample.tolerance)<0 || Number(sample.tolerance)>765))
          throw new Error(`${label}.file.samples.tolerance must be 0..765`);
      }
    }
    if (raw.file.reference !== undefined) validateReference(raw.file.reference,`${label}.file.reference`);
  }
  if (raw.capture !== undefined) {
    const capture=raw.capture;
    if (!record(capture)) throw new Error(`${label}.capture must be an object`);
    keys(capture,['anchor','width','height','reference','savePath']);
    if (!record(capture.anchor)) throw new Error(`${label}.capture.anchor must be an object`);
    keys(capture.anchor,['nameContains','role','inset']);
    nonempty(capture.anchor.nameContains,`${label}.capture.anchor.nameContains`);
    nonempty(capture.anchor.role,`${label}.capture.anchor.role`);
    if (!record(capture.anchor.inset)) throw new Error(`${label}.capture.anchor.inset must be an object`);
    keys(capture.anchor.inset,['x','y','unit']);
    for (const axis of ['x','y']) if (!Number.isInteger(capture.anchor.inset[axis]) ||
      Math.abs(Number(capture.anchor.inset[axis]))>1000)
      throw new Error(`${label}.capture.anchor.inset.${axis} must be an integer within 1000`);
    if (!['dip96','pixels'].includes(String(capture.anchor.inset.unit)))
      throw new Error(`${label}.capture.anchor.inset.unit must be dip96 or pixels`);
    for (const axis of ['width','height']) if (!Number.isInteger(capture[axis]) ||
      Number(capture[axis])<1 || Number(capture[axis])>10000)
      throw new Error(`${label}.capture.${axis} must be 1..10000`);
    if (Number(capture.width)*Number(capture.height)>16_000_000)
      throw new Error(`${label}.capture exceeds 16 megapixels`);
    if (capture.reference!==undefined) validateReference(capture.reference,`${label}.capture.reference`);
    if (capture.savePath!==undefined) safeRelative(capture.savePath,`${label}.capture.savePath`);
    if (capture.reference===undefined && capture.savePath===undefined)
      throw new Error(`${label}.capture needs reference or savePath`);
  }
}
export function assetPath(root: string, path: string): string {
  const resolved = resolve(root, path);
  const rel = relative(resolve(root), resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes recipe directory: ${path}`);
  return resolved;
}
export async function loadRecipe(directory: string): Promise<ReplayRecipe> {
  const manifestPath=join(directory,'manifest.json'),stepsPath=join(directory,'steps.json');
  const [manifestInfo,stepsInfo]=await Promise.all([stat(manifestPath),stat(stepsPath)]);
  if (manifestInfo.size > 100_000 || stepsInfo.size > 2_000_000)
    throw new Error('Replay manifest or steps exceed size limit');
  const [manifestSource,stepsSource]=await Promise.all([
    readFile(manifestPath,'utf8'),readFile(stepsPath,'utf8')]);
  const manifest: unknown = JSON.parse(manifestSource);
  const steps: unknown = JSON.parse(stepsSource);
  if (!record(manifest)) throw new Error('manifest.json must contain an object');
  const data: Record<string, unknown> = { ...manifest, steps };
  keys(data, ['schemaVersion','name','target','assets','steps']);
  if (data.schemaVersion !== 1) throw new Error('Unsupported recipe schemaVersion');
  nonempty(data.name, 'name');
  if (!record(data.target)) throw new Error('target must be an object');
  keys(data.target, ['titleContains','pid']);
  nonempty(data.target.titleContains, 'target.titleContains');
  if (data.target.pid !== undefined && (!Number.isInteger(data.target.pid) || Number(data.target.pid) < 1))
    throw new Error('target.pid must be a positive integer');
  if (data.assets !== undefined) {
    if (!Array.isArray(data.assets) || data.assets.length > 100) throw new Error('assets must contain at most 100 files');
    const paths = new Set<string>();
    for (const asset of data.assets) {
      if (!record(asset)) throw new Error('asset must be an object');
      keys(asset,['path','sha256']);
      const path = safeRelative(asset.path,'asset.path');
      if (!path.replaceAll('\\','/').startsWith('assets/')) throw new Error('asset.path must be under assets/');
      if (paths.has(path)) throw new Error(`Duplicate asset path: ${path}`);
      paths.add(path);
      if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256))
        throw new Error('asset.sha256 must be a SHA-256 hex digest');
    }
  }
  if (!Array.isArray(data.steps) || !data.steps.length || data.steps.length > 10000)
    throw new Error('steps must contain 1..10000 items');
  const ids = new Set<string>();
  for (const [index, raw] of data.steps.entries()) {
    if (!record(raw)) throw new Error(`steps[${index}] must be an object`);
    keys(raw, ['id','profile','action','actions','before','expect','settleTimeoutMs','settle']);
    const id = nonempty(raw.id, `steps[${index}].id`);
    if (ids.has(id)) throw new Error(`Duplicate step id: ${id}`);
    ids.add(id);nonempty(raw.profile, `steps[${index}].profile`);
    if ((raw.action===undefined)===(raw.actions===undefined))
      throw new Error(`${id} needs exactly one of action or actions`);
    const actions=raw.actions===undefined?[raw.action]:raw.actions;
    if (!Array.isArray(actions) || actions.length<1 || actions.length>256)
      throw new Error(`${id}.actions must contain 1..256 items`);
    for (const [actionIndex,action] of actions.entries()) {
      if (!record(action)) throw new Error(`${id}.actions[${actionIndex}] must be an object`);
      keys(action,['action','args']);nonempty(action.action,`${id}.actions[${actionIndex}].action`);
      if (!record(action.args)) throw new Error(`${id}.actions[${actionIndex}].args must be an object`);
    }
    if (raw.before !== undefined) validateCondition(raw.before,`${id}.before`,true);
    validateCondition(raw.expect,`${id}.expect`,true);
    if (raw.settleTimeoutMs !== undefined &&
      (!Number.isInteger(raw.settleTimeoutMs) || Number(raw.settleTimeoutMs) < 0 || Number(raw.settleTimeoutMs) > 30000))
      throw new Error(`${id}.settleTimeoutMs must be 0..30000`);
    if (raw.settle!==undefined) {
      if (!record(raw.settle)) throw new Error(`${id}.settle must be an object`);
      keys(raw.settle,['mode','quietMs','pollMs','timeoutMs']);
      if (raw.settle.mode!=='image') throw new Error(`${id}.settle.mode must be image`);
      for (const [key,min,max] of [['quietMs',50,2000],['pollMs',25,500],['timeoutMs',100,10000]] as const)
        if (!Number.isInteger(raw.settle[key]) || Number(raw.settle[key])<min || Number(raw.settle[key])>max)
          throw new Error(`${id}.settle.${key} must be ${min}..${max}`);
      if (Number(raw.settle.quietMs)>=Number(raw.settle.timeoutMs))
        throw new Error(`${id}.settle.quietMs must be below timeoutMs`);
    }
    for (const condition of [raw.before,raw.expect]) {
      const file=record(condition)?condition.file:undefined;
      const reference=record(file)?file.reference:undefined;
      const capture=record(condition)?condition.capture:undefined;
      const references=[reference,record(capture)?capture.reference:undefined];
      for (const ref of references) if (record(ref) &&
        !data.assets?.some((asset:unknown)=>record(asset) && asset.path===ref.asset))
        throw new Error(`${id} references an undeclared image asset`);
    }
  }
  return data as ReplayRecipe;
}
export async function checkFile(root: string, condition: NonNullable<ReplayStep['expect']['file']>,
  sourceRoot = root): Promise<void> {
  const path = assetPath(root, condition.path);
  const info = await stat(path);
  if (!info.isFile() || info.size < (condition.minBytes ?? 1)) throw new Error(`File postcondition failed: ${condition.path}`);
  if (condition.sha256) {
    const hash=createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex').toLowerCase() !== condition.sha256.toLowerCase())
      throw new Error(`File hash mismatch: ${condition.path}`);
  }
  if (condition.width !== undefined || condition.height !== undefined || condition.samples) {
    const metadata=await sharp(path).metadata();
    if ((condition.width !== undefined && metadata.width !== condition.width) ||
      (condition.height !== undefined && metadata.height !== condition.height))
      throw new Error(`Image dimensions mismatch: ${condition.path}`);
    if (condition.samples) {
      const width=metadata.width??0,height=metadata.height??0;
      if (!width || !height || width*height>16_000_000) throw new Error(`Image is too large for sample verification: ${condition.path}`);
      const image=await sharp(path).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
      for (const sample of condition.samples) {
        if (sample.x>=width || sample.y>=height) throw new Error(`Image sample outside bounds: ${condition.path}`);
        const offset=(sample.y*width+sample.x)*4;
        const distance=Math.abs(image.data[offset]-sample.rgb[0])+
          Math.abs(image.data[offset+1]-sample.rgb[1])+Math.abs(image.data[offset+2]-sample.rgb[2]);
        if (distance>(sample.tolerance??0)) throw new Error(`Image sample mismatch at ${sample.x},${sample.y}: ${condition.path}`);
      }
    }
  }
  if (condition.reference) await compareImageReference(path,assetPath(sourceRoot,condition.reference.asset),
    condition.reference,condition.path);
}
export async function compareImageReference(path:string,referencePath:string,reference:ReplayImageReference,
  label:string):Promise<void> {
  const [actualInfo,expectedInfo]=await Promise.all([sharp(path).metadata(),sharp(referencePath).metadata()]);
  if (!actualInfo.width || !actualInfo.height || actualInfo.width*actualInfo.height>16_000_000 ||
    actualInfo.width!==expectedInfo.width || actualInfo.height!==expectedInfo.height)
    throw new Error(`Image reference dimensions mismatch: ${label}`);
  const actual=await sharp(path).toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
  const expected=await sharp(referencePath).toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
  let changed=0;
  for (let i=0;i<actual.data.length;i+=3) {
    if (Math.abs(actual.data[i]-expected.data[i])>reference.channelTolerance ||
      Math.abs(actual.data[i+1]-expected.data[i+1])>reference.channelTolerance ||
      Math.abs(actual.data[i+2]-expected.data[i+2])>reference.channelTolerance) changed++;
  }
  const percent=changed*100/(actual.info.width*actual.info.height);
  if (percent>reference.maxChangedPercent)
    throw new Error(`Image reference mismatch: ${label} changed ${percent.toFixed(3)}% > ${reference.maxChangedPercent}%`);
}
