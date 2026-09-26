// Independent user-scenario acceptance. Uses disposable fixtures and real Aseprite CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exe = process.env.DP_ASEPRITE_EXE ?? 'C:\\Program Files\\Aseprite\\aseprite.exe';
const destination = resolve(process.argv[2] ?? join(root, 'out/acceptance', `workflow-${Date.now()}`));
const cli = join(root, 'node/dist/src/workflow/cli.js');
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination, { recursive: false });
const checks = [];
const hashes = new Map();
const references = new Map();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function command(program, args, timeoutMs = 120000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Timed out: ${program} ${args.join(' ')}`));
      else resolveResult({ code, stdout, stderr });
    });
  });
}
async function workflow(...args) {
  const result = await command(process.execPath, [cli, ...args]);
  let json;
  try { json = JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`CLI did not return one JSON result: ${JSON.stringify(result)}`); }
  return { ...result, json };
}
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, passed: true, elapsedMs: Date.now() - started, detail });
  } catch (error) {
    checks.push({ name, passed: false, elapsedMs: Date.now() - started, error: error.stack ?? String(error) });
  }
  process.stdout.write(`${checks.at(-1).passed ? 'PASS' : 'FAIL'} ${name}\n`);
  await writeFile(join(destination, 'acceptance.json'), JSON.stringify({ exe, checks }, null, 2));
}
async function config(name, inputDirectory, extra = {}) {
  const path = join(destination, `${name}.json`);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, name, inputDirectory,
    adapter: 'aseprite-png', executable: exe, onError: 'continue', maxItems: 100, ...extra }, null, 2));
  return path;
}
async function createFixture(relative, index, inputDirectory) {
  const width = 3 + index % 7, height = 2 + index % 5;
  const pixels = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const alpha = [0, 128, 255][p % 3];
    pixels[p * 4] = alpha ? (p * 29 + index * 17) % 256 : 0;
    pixels[p * 4 + 1] = alpha ? (p * 43 + index * 13) % 256 : 0;
    pixels[p * 4 + 2] = alpha ? (p * 71 + index * 7) % 256 : 0;
    pixels[p * 4 + 3] = alpha;
  }
  const png = join(destination, 'references', `${index}.png`);
  await mkdir(dirname(png), { recursive: true });
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(png);
  const source = join(inputDirectory, relative);
  await mkdir(dirname(source), { recursive: true });
  const created = await command(exe, ['--batch', png, '--save-as', source]);
  assert.equal(created.code, 0, created.stderr);
  const bytes = await readFile(source);
  assert.equal(bytes.readUInt16LE(4), 0xa5e0);
  assert.equal(bytes.readUInt16LE(6), 1);
  hashes.set(source, sha(bytes));
  references.set(relative.replace(/\.(aseprite|ase)$/i, '.png'), { width, height, pixels });
  return source;
}

const inputs = join(destination, '输入 素材');
await mkdir(inputs);
await check('prepare-real-single-frame-fixtures', async () => {
  for (let i = 0; i < 24; i++) {
    const relative = i < 2 ? `${i === 0 ? '角色' : '道具'}/同名.aseprite` :
      `${i % 2 ? '人物' : '场景'}/${i === 2 ? '-前缀 ' : ''}素材 ${i}.aseprite`;
    await createFixture(relative, i, inputs);
  }
  return { count: hashes.size };
});
const normalConfig = await config('normal', inputs);
const normalRun = join(destination, 'run-normal');
await check('U01-U02-real-24-item-batch-with-pixel-verification', async () => {
  assert.equal(hashes.size, 24, 'Fixture generation failed');
  const run = await workflow('run', normalConfig, '--run-dir', normalRun);
  assert.equal(run.code, 0, JSON.stringify(run));
  const report = JSON.parse(await readFile(join(normalRun, 'report.json'), 'utf8'));
  assert.equal(report.counts.total, 24);
  assert.equal(report.counts.completed, 24);
  for (const [relative, expected] of references) {
    const actual = await sharp(join(normalRun, 'artifacts', relative)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(actual.info.width, expected.width, relative);
    assert.equal(actual.info.height, expected.height, relative);
    assert.deepEqual(actual.data, expected.pixels, relative);
  }
  for (const [source, hash] of hashes) assert.equal(sha(await readFile(source)), hash, `Source modified: ${source}`);
  return { inputs: 24, outputs: 24, pixelExact: 24, sourceUnchanged: 24 };
});
await check('U06-complete-resume-never-rewrites-artifacts', async () => {
  const before = new Map();
  for (const relative of references.keys()) before.set(relative, (await stat(join(normalRun, 'artifacts', relative))).mtimeMs);
  const resumed = await workflow('resume', normalRun);
  // Either idempotent completed response or explicit already-completed rejection is acceptable.
  for (const [relative, time] of before) assert.equal((await stat(join(normalRun, 'artifacts', relative))).mtimeMs, time);
  const report = JSON.parse(await readFile(join(normalRun, 'report.json'), 'utf8'));
  assert.equal(report.counts.completed, 24);
  return { exitCode: resumed.code, unchanged: 24 };
});
await check('U17-same-rule-new-batch', async () => {
  const nextInput = join(destination, 'new-input'); await mkdir(nextInput);
  const first = [...hashes.keys()][0]; await copyFile(first, join(nextInput, 'new.aseprite'));
  const nextConfig = await config('new-batch', nextInput);
  const nextRun = join(destination, 'run-new');
  const result = await workflow('run', nextConfig, '--run-dir', nextRun);
  assert.equal(result.code, 0, JSON.stringify(result));
  const report = JSON.parse(await readFile(join(nextRun, 'report.json'), 'utf8'));
  assert.equal(report.counts.completed, 1);
});
await check('U03-mixed-valid-corrupt-and-unsupported', async () => {
  const mixed = join(destination, 'mixed'); await mkdir(mixed);
  await copyFile([...hashes.keys()][0], join(mixed, 'valid.aseprite'));
  await writeFile(join(mixed, 'corrupt.aseprite'), Buffer.from('broken aseprite data'));
  await writeFile(join(mixed, 'notes.txt'), 'unsupported input');
  // Extend an application-produced document with another cel frame, then have
  // Aseprite read and rewrite it to validate the animated fixture itself.
  const original = await readFile([...hashes.keys()][0]);
  const frameEnd = 128 + original.readUInt32LE(128);
  const cels = [];
  for (let offset = 144; offset < frameEnd;) {
    const size = original.readUInt32LE(offset);
    assert.ok(size >= 6 && offset + size <= frameEnd);
    if (original.readUInt16LE(offset + 4) === 0x2005) cels.push(original.subarray(offset, offset + size));
    offset += size;
  }
  assert.ok(cels.length > 0);
  const secondHeader = Buffer.alloc(16);
  secondHeader.writeUInt32LE(16 + cels.reduce((sum, bytes) => sum + bytes.length, 0), 0);
  secondHeader.writeUInt16LE(0xf1fa, 4);
  secondHeader.writeUInt16LE(cels.length, 6);
  secondHeader.writeUInt16LE(100, 8);
  const animation = Buffer.concat([original, secondHeader, ...cels]);
  animation.writeUInt32LE(animation.length, 0); animation.writeUInt16LE(2, 6);
  const animationDraft = join(destination, 'two-frame-draft.aseprite');
  await writeFile(animationDraft, animation);
  const animatedSource = join(mixed, 'animation.aseprite');
  const normalized = await command(exe, ['--batch', animationDraft, '--save-as', animatedSource]);
  assert.equal(normalized.code, 0, normalized.stderr);
  assert.equal((await readFile(animatedSource)).readUInt16LE(6), 2);
  const mixedConfig = await config('mixed', mixed);
  const mixedRun = join(destination, 'run-mixed');
  const result = await workflow('run', mixedConfig, '--run-dir', mixedRun);
  const report = JSON.parse(await readFile(join(mixedRun, 'report.json'), 'utf8'));
  assert.equal(report.counts.total, 4);
  assert.equal(report.counts.completed, 1);
  assert.equal(report.items.find(x => x.sourceRelativePath === 'corrupt.aseprite').status, 'failed');
  assert.equal(report.items.find(x => x.sourceRelativePath === 'notes.txt').status, 'unsupported');
  assert.equal(report.items.find(x => x.sourceRelativePath === 'animation.aseprite').status, 'unsupported');
  assert.notEqual(result.code, 0, 'Mixed errors must be reflected in exit status');
  return report.counts;
});
await check('U04-colliding-output-names-rejected-before-dispatch', async () => {
  const collision = join(destination, 'collision'); await mkdir(collision);
  await copyFile([...hashes.keys()][0], join(collision, 'same.ase'));
  await copyFile([...hashes.keys()][0], join(collision, 'same.aseprite'));
  const collisionConfig = await config('collision', collision);
  const result = await workflow('plan', collisionConfig);
  assert.notEqual(result.code, 0);
  assert.match(JSON.stringify(result.json), /collision|conflict/i);
});
await check('U11-U12-static-plan-does-not-load-untrusted-script', async () => {
  const marker = join(destination, 'SHOULD-NOT-EXIST');
  const author = join(destination, 'untrusted.mjs');
  await writeFile(author, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport default async function decideItem(){return {decision:'skip',reason:'test'};}\n`);
  const scriptConfig = await config('untrusted', inputs, { script: author });
  const validated = await workflow('validate', scriptConfig);
  assert.equal(validated.code, 0, JSON.stringify(validated));
  const planned = await workflow('plan', scriptConfig);
  assert.equal(planned.code, 0, JSON.stringify(planned));
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  const run = await workflow('run', scriptConfig, '--run-dir', join(destination, 'untrusted-run'));
  assert.notEqual(run.code, 0);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});
await check('U11-trusted-dynamic-item-decisions', async () => {
  const author = join(destination, 'filter.mjs');
  await writeFile(author, `export default async function decideItem(source){return source.relativePath.includes('角色') ? {decision:'skip',reason:'user excluded character samples'} : {decision:'export'};}\n`);
  const run = join(destination, 'run-filter');
  const result = await workflow('run', normalConfig, '--run-dir', run, '--trusted-script', author);
  assert.equal(result.code, 0, JSON.stringify(result));
  const report = JSON.parse(await readFile(join(run, 'report.json'), 'utf8'));
  assert.equal(report.counts.total, 24);
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.counts.completed, 23);
  return report.counts;
});
await check('U08-modified-completed-artifact-rejected-on-resume', async () => {
  const first = [...references.keys()][0];
  await writeFile(join(normalRun, 'artifacts', first), 'tampered output');
  const result = await workflow('resume', normalRun);
  assert.notEqual(result.code, 0);
  assert.match(JSON.stringify(result.json), /artifact|hash|changed|verif|reconcil/i);
});

const summary = { exe, outputDirectory: destination, total: checks.length,
  passed: checks.filter(x => x.passed).length, failed: checks.filter(x => !x.passed).length, checks };
await writeFile(join(destination, 'acceptance.json'), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify({ outputDirectory: destination, total: summary.total, passed: summary.passed, failed: summary.failed }) + '\n');
process.exitCode = summary.failed ? 1 : 0;
