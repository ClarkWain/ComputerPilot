import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { manifest, platforms } from '../lib/native.mjs';
import { nativeManifest } from './prepare-npm.mjs';

const at = process.argv.indexOf('--packages');
if (at < 0 || !process.argv[at + 1] || !process.env.npm_execpath) throw new Error('Run npm run smoke:npm -- --packages DIR');
const packages = resolve(process.argv[at + 1]), key = `${process.platform}-${process.arch}`, target = platforms[key];
if (!target) throw new Error(`Unsupported smoke-test platform: ${key}`);
const temporary = await mkdtemp(join(tmpdir(), 'computerpilot npm smoke '));
const prefix = join(temporary, 'global install'), packed = join(temporary, 'tarballs');
await mkdir(packed);
const config = join(temporary, 'empty.npmrc'); await writeFile(config, '');
const env = { ...process.env, npm_config_cache: join(temporary, 'cache'), npm_config_userconfig: config };
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: temporary, env, windowsHide: true, ...options });
  let stdout = '', stderr = '';
  child.stdout?.on('data', data => { stdout += data; }); child.stderr?.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} failed (${code}): ${stderr || stdout}`);
  return stdout;
}
const npm = args => run(process.execPath, [process.env.npm_execpath, ...args]);
const entries = new Map(), requested = [];
const server = createServer((request, response) => {
  const path = decodeURIComponent(request.url.split('?')[0]); requested.push(path);
  const name = path.split('/')[1], entry = entries.get(name);
  if (!entry) { response.writeHead(404); response.end('{"error":"not found"}'); return; }
  if (path === `/${name}` || path === `/${name}/${manifest.version}`) {
    const pkg = { ...entry.pkg, dist: { tarball: `${registry}/${name}/-/${entry.filename}`, integrity: entry.integrity } };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: pkg } }));
  } else if (path === `/${name}/-/${entry.filename}` && entry.bytes) {
    response.setHeader('content-type', 'application/octet-stream'); response.end(entry.bytes);
  } else { response.writeHead(404); response.end('{"error":"not found"}'); }
});
let registry;
try {
  for (const name of [manifest.name, target.name]) {
    const directory = join(packages, name), pkg = JSON.parse(await readFile(join(directory, 'package.json')));
    const result = JSON.parse(await npm(['pack', directory, '--ignore-scripts', '--json', '--pack-destination', packed]))[0];
    const bytes = await readFile(join(packed, result.filename));
    entries.set(name, { pkg, bytes, filename: result.filename, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` });
    assert.ok(!result.files.some(file => /(?:^|\/)(?:\.git|node_modules|observations)(?:\/|$)|\.(?:pt|onnx|jsonl|log|pdb)$/.test(file.path)));
  }
  for (const [other, definition] of Object.entries(platforms)) if (other !== key)
    entries.set(definition.name, { pkg: nativeManifest(other), filename: 'unsupported.tgz', integrity: `sha512-${createHash('sha512').update('').digest('base64')}` });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  registry = `http://127.0.0.1:${server.address().port}`;
  // Exercise the actual global-install and optional-platform selection paths without publishing anything.
  await npm(['install', '--global', '--prefix', prefix, `${manifest.name}@${manifest.version}`,
    '--registry', registry, '--ignore-scripts', '--no-audit', '--no-fund']);
  const modules = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules');
  const shim = process.platform === 'win32' ? join(prefix, 'computer-pilot.cmd') : join(prefix, 'bin/computer-pilot');
  assert.ok(existsSync(shim), 'npm did not create its command shim');
  const invoke = command => process.platform === 'win32'
    ? run(join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', `""${shim}" ${command}"`], { windowsVerbatimArguments: true })
    : run(shim, [command]);
  assert.equal((await invoke('--version')).trim(), manifest.version);
  assert.match(await invoke('--help'), /npm helpers:/);
  const info = JSON.parse(await invoke('info')), capabilities = JSON.parse(await invoke('capabilities'));
  assert.equal(info.version, manifest.version); assert.equal(capabilities.version, manifest.version); assert.equal(capabilities.name, 'ComputerPilot');
  assert.deepEqual(JSON.parse(await invoke('mcp-config')), { mcpServers: { 'computer-pilot': { command: info.executable, args: ['serve'] } } });
  const installEnv = { ...env };
  const entry = join(modules, manifest.name, 'bin/computer-pilot.mjs');
  assert.match(await run(process.execPath, [entry, 'mcp-config', '--format', 'toml']), /^\[mcp_servers.computer-pilot\]/);
  const pathKey = Object.keys(installEnv).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  installEnv[pathKey] = (process.platform === 'win32' ? prefix : join(prefix, 'bin')) + delimiter + installEnv[pathKey];
  const skillDirectory = join(temporary, 'manual skills');
  await run('pwsh', ['-NoProfile', '-File', join(info.skill, 'scripts/install.ps1'), '-SkillsDirectory', skillDirectory], { env: installEnv });
  const hint = JSON.parse((await readFile(join(skillDirectory, 'computerpilot/installation.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(hint.executable, info.executable); assert.equal(hint.root, info.root);
  for (const [other, definition] of Object.entries(platforms)) if (other !== key) {
    assert.ok(!existsSync(join(modules, definition.name)), 'npm installed the wrong platform');
    assert.ok(!requested.includes(`/${definition.name}/-/unsupported.tgz`), 'npm fetched the wrong native archive');
  }
  const child = spawn(process.execPath, [entry, 'serve'],
    { cwd: temporary, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  const pending = new Map(), input = createInterface({ input: child.stdout });
  child.stderr.on('data', () => {});
  input.on('line', line => {
    try { const value = JSON.parse(line); pending.get(value.id)?.(value); }
    catch (error) { for (const done of pending.values()) done({ error: { message: error.message } }); }
  });
  async function request(id, method, params = {}) {
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 15000);
      pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    assert.ok(!value.error, JSON.stringify(value.error)); return value.result;
  }
  try {
    const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'npm-smoke', version: '1' } });
    assert.equal(initialized.serverInfo.name, 'computer-pilot');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    assert.deepEqual((await request(2, 'tools/list')).tools.map(tool => tool.name), ['list_windows', 'get_window_state', 'execute_semantic', 'execute_batch']);
    child.stdin.end(); assert.equal(await exit, 0);
  } finally { input.close(); child.kill(); }
  console.log(`npm global install, platform selection, command shim (including spaces), skill path discovery, native capabilities and MCP stdio passed for ${key}.`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
