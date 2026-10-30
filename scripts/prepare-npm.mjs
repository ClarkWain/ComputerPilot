import { cp, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { manifest, packageRoot, platforms } from '../lib/native.mjs';

export function validateVersions(project = packageRoot) {
  const text = readFileSync(join(project, 'CMakeLists.txt'), 'utf8');
  const version = /project\(ComputerPilot VERSION (\d+\.\d+\.\d+)/.exec(text)?.[1];
  if (version !== manifest.version || Object.values(platforms).some(p => manifest.optionalDependencies[p.name] !== version))
    throw new Error('CMake, npm and native optional-dependency versions must match');
  return version;
}

export function nativeManifest(key) {
  const target = platforms[key];
  if (!target) throw new Error(`Unsupported platform: ${key}`);
  const [os, cpu] = key.split('-');
  return { name: target.name, version: manifest.version, description: `ComputerPilot native Core for ${key}`,
    license: manifest.license, author: manifest.author, repository: manifest.repository,
    os: [os], cpu: [cpu], publishConfig: { access: 'public' },
    files: ['bin/', 'profiles/', 'docs/', 'skills/', 'examples/', 'licenses/', '*.md', 'LICENSE', 'mcp.example.json', 'core-manifest.json'] };
}

export async function inspectCore(root, key) {
  const target = platforms[key];
  if (!target) throw new Error(`Unsupported platform: ${key}`);
  for (const name of [`bin/${target.binary}`, 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/MCP.md',
    'profiles/mspaint-classic-zh-CN/profile.json', 'skills/computerpilot/SKILL.md', 'core-manifest.json'])
    if (!existsSync(join(root, name))) throw new Error(`Core package is missing ${name}`);
  const core = JSON.parse(await readFile(join(root, 'core-manifest.json'), 'utf8'));
  if (core.name !== 'ComputerPilot' || core.version !== manifest.version)
    throw new Error(`Core version must match npm ${manifest.version}`);
  const walk = async directory => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Links are not allowed in Core packages: ${entry}`);
      if (/^(?:\.git|\.env(?:\..*)?|node_modules|installation\.json)$/.test(entry) ||
        /\.(?:pt|onnx|safetensors|pdb|log|jsonl|pem|key)$/i.test(entry))
        throw new Error(`Local/model artifact is not allowed in npm packages: ${entry}`);
      if (stat.isDirectory()) await walk(path);
    }
  };
  await walk(root);
}

export async function verifiedExtract(archive, sums, destination) {
  const name = archive.split(/[\\/]/).at(-1);
  const matches = sums.split(/\r?\n/).filter(line => line.endsWith(`  ${name}`));
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (matches.length !== 1 || matches[0] !== `${digest}  ${name}`) throw new Error(`Archive checksum mismatch: ${name}`);
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : existsSync('/usr/bin/bsdtar') ? '/usr/bin/bsdtar' : '/usr/bin/tar';
  if (process.platform === 'linux' && name.endsWith('.zip') && !existsSync('/usr/bin/bsdtar'))
    throw new Error('Install libarchive-tools (bsdtar) to prepare Windows ZIP releases on Linux');
  const paths = execFileSync(tar, ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const path of paths) {
    const parts = path.replaceAll('\\', '/').split('/');
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || parts[0] !== 'ComputerPilot' || parts.includes('..') || /[\x00-\x1f]/.test(path))
      throw new Error(`Unsafe archive path: ${path}`);
  }
  const types = execFileSync(tar, ['-tvf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  if (types.some(line => !/^[d-]/.test(line))) throw new Error('Archive links or special files are not allowed');
  await mkdir(destination);
  execFileSync(tar, ['-xf', archive, '-C', destination], { stdio: 'pipe' });
  return join(destination, 'ComputerPilot');
}

export async function preparePackages({ output, core, platform, assets }) {
  validateVersions();
  output = resolve(output);
  if (existsSync(output)) throw new Error('Use a new npm output directory; existing contents are never overwritten');
  if (!!assets === !!core || (core && !platform)) throw new Error('Use --assets DIR, or --core DIR --platform win32-x64|darwin-arm64');
  const temporary = await mkdtemp(join(tmpdir(), 'computerpilot-pack-'));
  try {
    const cores = [];
    if (core) { await inspectCore(core, platform); cores.push([platform, resolve(core)]); }
    else {
      const sums = await readFile(join(assets, 'SHA256SUMS.txt'), 'utf8');
      for (const [key, target] of Object.entries(platforms)) {
        const directory = await verifiedExtract(resolve(assets, target.asset), sums, join(temporary, key));
        await inspectCore(directory, key); cores.push([key, directory]);
      }
    }
    await mkdir(output, { recursive: true });
    const wrapper = join(output, manifest.name); await mkdir(wrapper);
    for (const name of manifest.files) await cp(join(packageRoot, name), join(wrapper, name), { recursive: true });
    const packed = { ...manifest }; delete packed.scripts; delete packed.private;
    await writeFile(join(wrapper, 'package.json'), JSON.stringify(packed, null, 2) + '\n');
    await chmod(join(wrapper, 'bin/computer-pilot.mjs'), 0o755);
    const packages = [];
    for (const [key, source] of cores) {
      const target = platforms[key], directory = join(output, target.name);
      await cp(source, directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify(nativeManifest(key), null, 2) + '\n');
      if (key === 'darwin-arm64') await chmod(join(directory, 'bin', target.binary), 0o755);
      packages.push(target.name);
    }
    packages.push(manifest.name); // Publish the entry package only after both native packages.
    await writeFile(join(output, 'packages.json'), JSON.stringify({ version: manifest.version, packages }, null, 2) + '\n');
    return { output, packages };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = { '--out': 'output', '--core': 'core', '--platform': 'platform', '--assets': 'assets' }[process.argv[i]];
      if (!key || !process.argv[i + 1]) throw new Error('Expected --out DIR and either --assets DIR or --core DIR --platform PLATFORM');
      options[key] = process.argv[i + 1];
    }
    if (!options.output) throw new Error('--out is required');
    console.log(JSON.stringify(await preparePackages(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
