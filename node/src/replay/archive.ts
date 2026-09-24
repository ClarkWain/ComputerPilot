import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import { assetPath, loadRecipe, type ReplayRecipe } from './recipe.js';

const maxArchiveBytes = 50_000_000;
const maxEntryBytes = 20_000_000;
const maxTotalBytes = 80_000_000;
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
function rejectMachinePaths(value: unknown): void {
  if (typeof value === 'string') {
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value))
      throw new Error(`Absolute paths cannot be exported for sharing: ${value}`);
  } else if (Array.isArray(value)) value.forEach(rejectMachinePaths);
  else if (value && typeof value === 'object') Object.values(value).forEach(rejectMachinePaths);
}

export async function assetBytes(root: string, recipe: ReplayRecipe): Promise<Array<{path:string;data:Buffer}>> {
  const result: Array<{path:string;data:Buffer}> = [];
  const realRoot=await realpath(root);
  for (const asset of recipe.assets ?? []) {
    const path=assetPath(root,asset.path);
    const actual=await realpath(path);
    const rel=relative(realRoot,actual);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Asset escapes recipe directory: ${asset.path}`);
    if ((await stat(actual)).size>maxEntryBytes) throw new Error(`Asset is too large: ${asset.path}`);
    const data=await readFile(actual);
    if (data.length > maxEntryBytes) throw new Error(`Asset is too large: ${asset.path}`);
    if (digest(data).toLowerCase() !== asset.sha256.toLowerCase()) throw new Error(`Asset hash mismatch: ${asset.path}`);
    result.push({path:asset.path.replaceAll('\\','/'),data});
  }
  return result;
}

export async function exportArchive(sourceDirectory: string, destination: string): Promise<void> {
  const root=resolve(sourceDirectory);
  const recipe=await loadRecipe(root);
  if (recipe.target.pid !== undefined) throw new Error('A fixed process ID cannot be exported for sharing');
  for (const step of recipe.steps)
    for (const action of step.actions??[step.action!]) rejectMachinePaths(action.args);
  const assets=await assetBytes(root,recipe);
  const zip=new AdmZip();
  zip.addFile('manifest.json',await readFile(join(root,'manifest.json')));
  zip.addFile('steps.json',await readFile(join(root,'steps.json')));
  for (const asset of assets) zip.addFile(asset.path,asset.data);
  const data=zip.toBuffer();
  if (data.length > maxArchiveBytes) throw new Error('Replay archive exceeds 50 MB');
  await writeFile(destination,data,{flag:'wx'});
}

export async function openArchive(archivePath: string): Promise<{directory:string;cleanup:()=>Promise<void>}> {
  if ((await stat(archivePath)).size>maxArchiveBytes) throw new Error('Replay archive exceeds 50 MB');
  const bytes=await readFile(archivePath);
  if (bytes.length > maxArchiveBytes) throw new Error('Replay archive exceeds 50 MB');
  const zip=new AdmZip(bytes);
  const entries=zip.getEntries();
  if (entries.length > 102) throw new Error('Replay archive has too many entries');
  const seen=new Set<string>();let total=0;
  const files:Array<{name:string;data:Buffer}>=[];
  for (const entry of entries) {
    const name=entry.entryName;
    if (entry.isDirectory || name.includes('\\') || name.startsWith('/') ||
      name.split('/').some(part=>!part || part==='.' || part==='..') ||
      !(name==='manifest.json' || name==='steps.json' || name.startsWith('assets/')) || seen.has(name))
      throw new Error(`Unsafe or duplicate archive entry: ${name}`);
    seen.add(name);
    if (entry.header.size > maxEntryBytes) throw new Error(`Archive entry is too large: ${name}`);
    total+=entry.header.size;
    if (total > maxTotalBytes) throw new Error('Replay archive expands beyond 80 MB');
    const data=entry.getData();
    if (data.length > maxEntryBytes) throw new Error(`Archive entry is too large: ${name}`);
    files.push({name,data});
  }
  if (!seen.has('manifest.json') || !seen.has('steps.json')) throw new Error('Replay archive lacks manifest or steps');
  const directory=await mkdtemp(join(tmpdir(),'desktop-pilot-replay-'));
  const cleanup=()=>rm(directory,{recursive:true,force:true});
  try {
    for (const file of files) {
      const path=assetPath(directory,file.name);
      await mkdir(dirname(path),{recursive:true});
      await writeFile(path,file.data,{flag:'wx'});
    }
    const recipe=await loadRecipe(directory);
    const declared=new Set((recipe.assets??[]).map(x=>x.path.replaceAll('\\','/')));
    for (const file of files) if (file.name.startsWith('assets/') && !declared.has(file.name))
      throw new Error(`Undeclared asset: ${file.name}`);
    await assetBytes(directory,recipe);
    return {directory,cleanup};
  } catch(error) { await cleanup();throw error; }
}
