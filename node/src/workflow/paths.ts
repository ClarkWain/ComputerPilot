import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type { WorkflowSource } from './types.js';

export function pathKey(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function safeRelativePath(value: string, label = 'path'): string {
  if (!value || value.includes('\0') || isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('\\'))
    throw new Error(`${label} must be a relative path`);
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[:<>"|?*]/.test(part) || /[ .]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)))
    throw new Error(`${label} contains an invalid path component`);
  return parts.join(sep);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function assertRegularFileNoSymlink(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Input is not a regular non-link file: ${path}`);
}

async function walkFiles(root: string, directory: string, output: string[], maxItems: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Input tree contains a symlink or junction: ${path}`);
    if (info.isDirectory()) await walkFiles(root, path, output, maxItems);
    else if (info.isFile()) {
      output.push(path);
      if (output.length > maxItems) throw new Error(`Input contains more than maxItems (${maxItems}) files`);
    }
    else throw new Error(`Input tree contains a special file: ${path}`);
  }
}

export async function snapshotInputFiles(inputDirectory: string, maxItems: number): Promise<WorkflowSource[]> {
  const rootCandidate = resolve(inputDirectory);
  const rootInfo = await lstat(rootCandidate);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('inputDirectory must be a real directory, not a link');
  const root = await realpath(rootCandidate);
  const files: string[] = [];
  await walkFiles(root, root, files, maxItems);
  if (!files.length) throw new Error('inputDirectory contains no files');
  const result: WorkflowSource[] = [];
  for (const absolutePath of files) {
    const infoBefore = await lstat(absolutePath);
    await assertRegularFileNoSymlink(absolutePath);
    const actualPath = await realpath(absolutePath);
    if (!isWithin(root, actualPath)) throw new Error(`Input resolves outside inputDirectory: ${absolutePath}`);
    const sha256 = await sha256File(actualPath);
    const infoAfter = await lstat(absolutePath);
    if (infoAfter.isSymbolicLink() || infoBefore.dev !== infoAfter.dev || infoBefore.ino !== infoAfter.ino ||
        infoBefore.size !== infoAfter.size || infoBefore.mtimeMs !== infoAfter.mtimeMs)
      throw new Error(`Input changed while it was being inventoried: ${absolutePath}`);
    const relativePath = relative(root, absolutePath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
      throw new Error(`Input path escaped inputDirectory: ${absolutePath}`);
    result.push({ relativePath, absolutePath, size: infoAfter.size, sha256 });
  }
  return result;
}

export function outputRelativePath(sourceRelativePath: string): string {
  const safe = safeRelativePath(sourceRelativePath, 'source path');
  const extension = extname(safe);
  const base = safe.slice(0, safe.length - extension.length);
  return `${base}.png`;
}

export async function assertNoSymlinkPath(rootPath: string, relativePath: string, allowMissingLeaf = true): Promise<string> {
  const root = resolve(rootPath);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Path root is not a real directory: ${root}`);
  const safe = safeRelativePath(relativePath);
  const target = resolve(root, safe);
  if (!isWithin(root, target) || pathKey(root) === pathKey(target)) throw new Error(`Path escapes its root: ${relativePath}`);
  const rel = relative(root, target);
  let cursor = root;
  const parts = rel.split(sep);
  for (let index = 0; index < parts.length; index++) {
    cursor = resolve(cursor, parts[index]);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`Path contains a symlink or junction: ${cursor}`);
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`Path parent is not a directory: ${cursor}`);
      if (index === parts.length - 1 && !info.isFile() && !info.isDirectory())
        throw new Error(`Path is not a regular file or directory: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!allowMissingLeaf || index < parts.length - 1) {
        // Missing ancestors are okay only when all later components are also to be created by us.
        if (!allowMissingLeaf) throw error;
      }
      break;
    }
  }
  return target;
}

export async function ensureDirectoryNoLinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const parts: string[] = [];
  let cursor = absolute;
  const root = parse(absolute).root;
  while (cursor !== root) { parts.push(cursor); cursor = dirname(cursor); }
  let parent = root;
  for (const component of parts.reverse()) {
    parent = resolve(parent, relative(parent, component));
    try {
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Directory path contains a link or non-directory: ${parent}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await mkdir(absolute, { recursive: true });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Directory is not a real directory: ${absolute}`);
}

export async function assertOutputOutsideInput(inputDirectory: string, runDirectory: string): Promise<void> {
  const input = await realpath(inputDirectory);
  const run = resolve(runDirectory);
  const lexicalParent=resolve(dirname(run));
  const parent = await realpath(lexicalParent);
  if (pathKey(parent)!==pathKey(lexicalParent)) throw new Error('runDirectory parent path must not contain a symlink or junction');
  const candidate = resolve(parent, basename(run));
  if (isWithin(input, candidate) || isWithin(candidate, input))
    throw new Error('runDirectory must be separate from inputDirectory');
  // If the destination already exists, reject aliases/reparse points before creating any run files.
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('runDirectory must be a new real directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function verifySourceSnapshot(source: WorkflowSource, inputRoot: string): Promise<void> {
  const rootPath=resolve(inputRoot);
  const rootInfo=await lstat(rootPath);
  if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error('inputDirectory is no longer a real directory');
  const actualRoot=await realpath(rootPath);
  if(pathKey(actualRoot)!==pathKey(rootPath))throw new Error('inputDirectory now resolves through a symlink or junction');
  const safe = safeRelativePath(source.relativePath, 'source path');
  const expected = resolve(rootPath, safe);
  if (pathKey(expected) !== pathKey(source.absolutePath)) throw new Error('Frozen source path no longer matches its relative path');
  let cursor=rootPath;
  const parts=safe.split(sep);
  for (let index=0;index<parts.length;index++) {
    cursor=resolve(cursor,parts[index]);
    const component=await lstat(cursor);
    if (component.isSymbolicLink()) throw new Error(`Source path now contains a symlink or junction: ${cursor}`);
    if (index<parts.length-1 && !component.isDirectory()) throw new Error(`Source parent is not a directory: ${cursor}`);
    if (index===parts.length-1 && !component.isFile()) throw new Error(`Source is not a regular file: ${cursor}`);
  }
  const actual = await realpath(expected);
  const root = actualRoot;
  if (!isWithin(root, actual)) throw new Error('Source now resolves outside inputDirectory');
  const info = await stat(actual);
  if (info.size !== source.size || await sha256File(actual) !== source.sha256)
    throw new Error(`Input changed since the batch was planned: ${source.relativePath}`);
}
