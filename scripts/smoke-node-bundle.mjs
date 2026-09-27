import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundle = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
const runtime = resolve(bundle, 'runtime/node.exe');
const execFileAsync = promisify(execFile);
assert.equal(await realpath(process.execPath), await realpath(runtime),
  'Run this smoke test with the bundled runtime/node.exe');
const systemRoot = process.env.SystemRoot ?? 'C:/Windows';
process.env.PATH = `${resolve(systemRoot, 'System32')};${systemRoot}`;
for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV',
  'DP_NATIVE_EXE', 'DP_PROFILES_DIR', 'DP_OMNIPARSER_ONNX']) delete process.env[key];

const manifest = JSON.parse(await readFile(resolve(bundle, 'bundle-manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.platform, 'win32-x64');
assert.equal(process.version, `v${manifest.nodeVersion}`);
for (const item of manifest.files) {
  assert.equal(typeof item.path, 'string');
  assert.ok(!item.path.includes('..') && !item.path.startsWith('/'), 'Unsafe manifest path');
  const file = resolve(bundle, item.path);
  assert.ok(file.startsWith(bundle + sep), 'Manifest path escapes bundle');
  assert.equal((await stat(file)).size, item.bytes, `Unexpected size: ${item.path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest('hex'), item.sha256, `SHA-256 mismatch: ${item.path}`);
}

const modelModule = await import(pathToFileURL(resolve(bundle, 'node/dist/src/vision/model.js')).href);
const detectorModule = await import(pathToFileURL(resolve(bundle, 'node/dist/src/vision/detector.js')).href);
await modelModule.OcrModels.load(resolve(bundle, 'models/ocr'));
await detectorModule.OnnxDetector.load(resolve(bundle, 'models/icon_detect_v3/model.onnx'));

// The launcher gets no global Node path, no source checkout cwd, and no development overrides.
const env = { ...process.env };
const child = spawn(runtime, [resolve(bundle, 'node/dist/src/index.js')], {
  cwd: process.env.TEMP ?? bundle, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
const buffered = new Map();
let stderr = '';
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); }
  catch { stderr += `Non-JSON stdout: ${line}\n`; return; }
  if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  else buffered.set(message.id, message);
});
function request(id, method, params = {}) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  if (buffered.has(id)) { const value = buffered.get(id); buffered.delete(id); return Promise.resolve(value); }
  return new Promise((fulfill, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${stderr}`)); }, 20_000);
    pending.set(id, value => { clearTimeout(timer); fulfill(value); });
  });
}
try {
  const hello = await request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'portable-smoke', version: '1' },
  });
  assert.equal(hello.result?.protocolVersion, '2025-06-18', JSON.stringify(hello));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request(2, 'tools/list');
  assert.deepEqual(listed.result?.tools?.map(tool => tool.name),
    ['list_windows', 'get_window_state', 'execute_semantic', 'execute_batch']);
  const windows = await request(3, 'tools/call', { name: 'list_windows', arguments: {} });
  assert.equal(windows.result?.isError, false, JSON.stringify(windows));
  assert.deepEqual(windows.result?.content, []);
  assert.equal(windows.result?.structuredContent?.status, 'ok');
  assert.ok(Array.isArray(windows.result?.structuredContent?.windows));
  const scratch=await mkdtemp(join(tmpdir(),'desktop-pilot-bundle-replay-'));
  try {
    const cli=resolve(bundle,'node/dist/src/replay/cli.js');
    await writeFile(join(scratch,'manifest.json'),JSON.stringify({schemaVersion:1,name:'smoke',target:{titleContains:'Paint'}}));
    await writeFile(join(scratch,'steps.json'),JSON.stringify([{id:'save',profile:'paint',
      action:{action:'document.saveAs',args:{path:'{{runDir}}/output.png'}},
      expect:{file:{path:'output.png',minBytes:1}}}]));
    const archive=join(scratch,'smoke.dpreplay');
    await execFileAsync(runtime,[cli,'validate',scratch],{env});
    await execFileAsync(runtime,[cli,'export',scratch,archive],{env});
    await execFileAsync(runtime,[cli,'validate',archive],{env});
    const orchestration=resolve(bundle,'node/dist/src/orchestration/cli.js');
    const script=join(scratch,'workflow.mjs');
    const definition=join(scratch,'orchestration.json');
    await writeFile(script,'export default async function run(ctx) { await ctx.checkpoint("ready"); }\n');
    await writeFile(definition,JSON.stringify({schemaVersion:1,name:'portable-orchestration',
      script:'workflow.mjs',input:{}}));
    const check=await execFileAsync(runtime,[orchestration,'validate',definition],{env});
    assert.equal(JSON.parse(check.stdout).ok,true);
    const runDir=join(scratch,'run');
    const started=await execFileAsync(runtime,[orchestration,'run',definition,
      '--trusted-script',script,'--run-dir',runDir],{env});
    assert.equal(JSON.parse(started.stdout).status,'completed');
    const resumed=await execFileAsync(runtime,[orchestration,'resume',runDir,
      '--trusted-script',script],{env});
    assert.equal(JSON.parse(resumed.stdout).status,'completed');
  } finally { await rm(scratch,{recursive:true,force:true}); }
  console.log(`Portable bundle smoke passed: ${manifest.files.length} verified files, OCR and detector loaded, four MCP tools, read-only window listing, Replay validate/export/import, orchestration run/resume`);
} finally {
  child.kill();
}
