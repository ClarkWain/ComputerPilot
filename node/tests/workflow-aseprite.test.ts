import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createAsepritePngAdapter, parseAsepriteHeader } from '../src/workflow/adapters/aseprite.js';
import type { WorkflowSource } from '../src/workflow/types.js';

const defaultExe = 'C:\\Program Files\\Aseprite\\aseprite.exe';
const asepriteExe = process.env.DP_ASEPRITE_EXE ?? defaultExe;

function header(frames = 1, width = 2, height = 1): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(bytes.length, 0);
  bytes.writeUInt16LE(0xa5e0, 4);
  bytes.writeUInt16LE(frames, 6);
  bytes.writeUInt16LE(width, 8);
  bytes.writeUInt16LE(height, 10);
  bytes.writeUInt16LE(32, 12);
  return bytes;
}

function source(path: string, size = 128, relativePath = 'source.aseprite'): WorkflowSource {
  return { relativePath, absolutePath: path, size, sha256: '0'.repeat(64) };
}

async function command(executable: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 16_384); });
    child.once('error', rejectCommand);
    child.once('close', code => resolveCommand({ code, stderr }));
  });
}

test('Aseprite header parser checks magic, declared size, dimensions, depth, and frames', () => {
  assert.deepEqual(parseAsepriteHeader(header()), { fileSize: 128, frames: 1, width: 2, height: 1, depth: 32 });
  assert.throws(() => parseAsepriteHeader(Buffer.alloc(12)), /truncated/i);
  const badMagic = header(); badMagic.writeUInt16LE(0, 4);
  assert.throws(() => parseAsepriteHeader(badMagic), /magic/i);
  const badSize = header(); badSize.writeUInt32LE(129, 0);
  assert.throws(() => parseAsepriteHeader(badSize), /size header mismatch/i);
  assert.throws(() => parseAsepriteHeader(header(0)), /no frames/i);
  assert.equal(parseAsepriteHeader(header(2)).frames, 2);
});

test('probe rejects malformed and multi-frame documents without writing output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pilot-ase-probe-'));
  try {
    const malformed = join(directory, 'broken.aseprite');
    const animated = join(directory, 'animation.aseprite');
    const singleFrame = join(directory, 'single-frame.aseprite');
    const oversized = join(directory, 'oversized.aseprite');
    const notes = join(directory, 'notes.txt');
    await writeFile(malformed, Buffer.alloc(32));
    await writeFile(animated, header(3));
    await writeFile(singleFrame, header());
    await writeFile(oversized, header(1, 4000, 4001));
    await writeFile(notes, 'not an Aseprite source');
    const adapter = createAsepritePngAdapter({ executable: asepriteExe });
    assert.equal(adapter.version, 'aseprite-png-v1');
    const bad = await adapter.probe(source(malformed, 32));
    assert.equal(bad.status, 'failed');
    if (bad.status === 'failed') assert.equal(bad.code, 'invalid_aseprite_source');
    const multi = await adapter.probe(source(animated));
    assert.equal(multi.status, 'unsupported');
    if (multi.status === 'unsupported') assert.equal(multi.code, 'aseprite_animation_unsupported');
    const supported = await adapter.probe(source(singleFrame));
    assert.equal(supported.status, 'supported');
    if (supported.status === 'supported') assert.deepEqual(supported.expected, {
      format: 'aseprite', frames: 1, width: 2, height: 1, depth: 32, fileSize: 128
    });
    const tooLarge = await adapter.probe(source(oversized));
    assert.equal(tooLarge.status, 'unsupported');
    if (tooLarge.status === 'unsupported') assert.equal(tooLarge.code, 'aseprite_dimensions_too_large');
    const textFile = await adapter.probe(source(notes, 22, 'notes.txt'));
    assert.equal(textFile.status, 'unsupported');
    if (textFile.status === 'unsupported') assert.equal(textFile.code, 'unsupported_source_extension');
    assert.deepEqual(await readdir(directory), ['animation.aseprite', 'broken.aseprite', 'notes.txt', 'oversized.aseprite', 'single-frame.aseprite']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('verify checks PNG signature and dimensions and reports alpha evidence without claiming image equivalence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pilot-ase-verify-'));
  try {
    const output = join(directory, 'candidate.png');
    await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]),
      { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(output);
    const adapter = createAsepritePngAdapter({ executable: asepriteExe });
    const valid = await adapter.verify(output, { width: 2, height: 1 });
    assert.equal(valid.status, 'verified');
    assert.equal(valid.actual?.alphaChannel, true);
    assert.equal(valid.actual?.transparentPixelEvidence, true);
    assert.match(String(valid.actual?.claimScope), /content equivalence is not verified/);
    const wrongSize = await adapter.verify(output, { width: 3, height: 1 });
    assert.equal(wrongSize.status, 'failed');

    const opaquePng = await sharp(Buffer.from([0, 255, 0, 0, 0, 255]),
      { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer();
    const truncated = join(directory, 'truncated.png');
    await writeFile(truncated, opaquePng.subarray(0, Math.min(33, opaquePng.length - 1)));
    const corrupt = await adapter.verify(truncated, { width: 2, height: 1 });
    assert.equal(corrupt.status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('execute refuses to overwrite an existing destination before spawning Aseprite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pilot-ase-conflict-'));
  try {
    const input = join(directory, 'source.aseprite');
    const destination = join(directory, 'already.png');
    await writeFile(input, header());
    await writeFile(destination, 'keep this');
    const adapter = createAsepritePngAdapter({
      executable: asepriteExe,
      spawnProcess: () => { throw new Error('must not spawn'); }
    });
    const receipt = await adapter.execute(input, destination);
    assert.equal(receipt.status, 'failed');
    if (receipt.status === 'failed') assert.equal(receipt.code, 'output_exists');
    assert.equal(await readFile(destination, 'utf8'), 'keep this');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('execute preserves a destination created after the initial check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pilot-ase-output-race-'));
  try {
    const input = join(directory, 'source.aseprite');
    const destination = join(directory, 'race.png');
    await writeFile(input, header());
    const adapter = createAsepritePngAdapter({ executable: process.execPath, spawnProcess: (_exe, args) => {
      const script = 'require("node:fs").writeFileSync(process.argv[1], "candidate");require("node:fs").writeFileSync(process.argv[2], "preserve")';
      return spawn(process.execPath, ['-e', script, args[3], destination],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } });
    const receipt = await adapter.execute(input, destination);
    assert.equal(receipt.status, 'failed');
    if (receipt.status === 'failed') {
      assert.equal(receipt.code, 'output_exists');
      assert.equal(receipt.dispatch, 'completed');
      assert.equal(await readFile(destination, 'utf8'), 'preserve');
      assert.equal(await readFile(String(receipt.details?.artifactPath), 'utf8'), 'candidate');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('timeout and cancellation terminate the spawned child and report unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pilot-ase-interrupt-'));
  try {
    const input = join(directory, 'source.aseprite');
    await writeFile(input, header());
    const hangingSpawn = () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timeoutAdapter = createAsepritePngAdapter({ executable: process.execPath, timeoutMs: 30, spawnProcess: hangingSpawn });
    const timedOut = await timeoutAdapter.execute(input, join(directory, 'timeout.png'));
    assert.equal(timedOut.status, 'unknown');
    if (timedOut.status === 'unknown') assert.equal(timedOut.code, 'aseprite_timeout');

    const controller = new AbortController();
    const cancelAdapter = createAsepritePngAdapter({ executable: process.execPath, timeoutMs: 5000, spawnProcess: hangingSpawn });
    const pending = cancelAdapter.execute(input, join(directory, 'cancelled.png'), controller.signal);
    setTimeout(() => controller.abort(), 30);
    const cancelled = await pending;
    assert.equal(cancelled.status, 'unknown');
    if (cancelled.status === 'unknown') assert.equal(cancelled.code, 'cancelled');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('spawn failure is a not-started result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pilot-ase-spawn-'));
  try {
    const input = join(directory, 'source.aseprite');
    await writeFile(input, header());
    const adapter = createAsepritePngAdapter({ executable: asepriteExe,
      spawnProcess: () => { throw new Error('executable not found'); } });
    const receipt = await adapter.execute(input, join(directory, 'candidate.png'));
    assert.equal(receipt.status, 'failed');
    if (receipt.status === 'failed') {
      assert.equal(receipt.dispatch, 'not_started');
      assert.equal(receipt.code, 'aseprite_start_failed');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('nonzero CLI exit retains bounded stderr and a possible artifact path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pilot-ase-exit-'));
  try {
    const input = join(directory, 'source.aseprite');
    const destination = join(directory, 'final.png');
    await writeFile(input, header());
    const adapter = createAsepritePngAdapter({ executable: process.execPath, spawnProcess: (_exe, args) => {
      const script = 'require("node:fs").writeFileSync(process.argv[1], "partial");console.log("x".repeat(100000));console.error("synthetic export failure");process.exitCode=17';
      return spawn(process.execPath, ['-e', script, args[3]], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } });
    const receipt = await adapter.execute(input, destination);
    assert.equal(receipt.status, 'failed');
    assert.equal(existsSync(destination), true);
    if (receipt.status === 'failed') {
      assert.equal(receipt.dispatch, 'completed');
      assert.equal(receipt.code, 'aseprite_export_failed');
      assert.match(String(receipt.details?.stderr), /synthetic export failure/);
      assert.equal(String(receipt.details?.stdout).length, 16 * 1024);
      assert.equal(receipt.details?.artifactPath, destination);
      assert.equal(await readFile(destination, 'utf8'), 'partial');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real Aseprite CLI exports a single-frame PNG with Unicode, spaces, and dash-prefixed filename',
  { skip: !existsSync(asepriteExe) }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'DesktopPilot 素材 with spaces - '));
    try {
      const inputPng = join(directory, '-透明 源.png');
      const inputAse = join(directory, '-透明 源.aseprite');
      const outputDirectory = join(directory, '输出 图片');
      await mkdir(outputDirectory);
      await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]),
        { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(inputPng);
      const created = await command(asepriteExe, ['--batch', resolve(inputPng), '--save-as', resolve(inputAse)]);
      assert.equal(created.code, 0, created.stderr);
      const output = join(outputDirectory, 'PNG 结果 - 草稿.png');
      const adapter = createAsepritePngAdapter({ executable: asepriteExe });
      const probe = await adapter.probe(source(inputAse, (await stat(inputAse)).size));
      assert.equal(probe.status, 'supported');
      if (probe.status !== 'supported') return;
      assert.equal(probe.expected.width, 2);
      assert.equal(probe.expected.height, 1);
      const receipt = await adapter.execute(inputAse, output);
      assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
      const evidence = await adapter.verify(output, probe.expected);
      assert.equal(evidence.status, 'verified', JSON.stringify(evidence));
      assert.equal(evidence.actual?.format, 'png');
      assert.equal(evidence.actual?.width, 2);
      assert.equal(evidence.actual?.height, 1);
      assert.equal(typeof evidence.actual?.alphaChannel, 'boolean');
      assert.equal(evidence.actual?.alphaChannel, true);
      assert.equal(evidence.actual?.transparentPixelEvidence, true);
      const decoded = await sharp(output).ensureAlpha().raw().toBuffer();
      assert.deepEqual([decoded[3], decoded[7]], [255, 0]);
      assert.deepEqual([...decoded.subarray(0, 3)], [255, 0, 0]);
      assert.match(String(evidence.actual?.claimScope), /content equivalence is not verified/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
