import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, open, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import sharp from 'sharp';
import type { ExecuteReceipt, ProbeResult, VerificationEvidence, WorkflowAdapter, WorkflowSource } from '../types.js';

const ASEPRITE_EXE = 'C:\\Program Files\\Aseprite\\aseprite.exe';
const ASEPRITE_MAGIC = 0xa5e0;
const HEADER_BYTES = 128;
const STDERR_LIMIT = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_ESCALATION_MS = 500;
const MAX_VERIFY_PIXELS = 16_000_000;

export type AsepriteHeader = {
  fileSize: number;
  frames: number;
  width: number;
  height: number;
  depth: number;
};

export type AsepriteAdapterOptions = {
  executable?: string;
  timeoutMs?: number;
  /** Internal seam for deterministic process lifecycle tests. */
  spawnProcess?: (executable: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
};

type ProcessOutcome = { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string } |
  { kind: 'spawn_error'; message: string; stderr: string; stdout: string } |
  { kind: 'process_error'; message: string; stderr: string; stdout: string } |
  { kind: 'interrupted'; reason: 'timeout' | 'cancelled'; stderr: string; stdout: string };

export function parseAsepriteHeader(bytes: Buffer, actualFileSize = bytes.length): AsepriteHeader {
  if (actualFileSize < HEADER_BYTES || bytes.length < HEADER_BYTES)
    throw new Error('Aseprite file is truncated before its 128-byte header');
  const fileSize = bytes.readUInt32LE(0);
  const magic = bytes.readUInt16LE(4);
  const frames = bytes.readUInt16LE(6);
  const width = bytes.readUInt16LE(8);
  const height = bytes.readUInt16LE(10);
  const depth = bytes.readUInt16LE(12);
  if (magic !== ASEPRITE_MAGIC) throw new Error('Aseprite file magic is invalid');
  if (fileSize !== actualFileSize) throw new Error(`Aseprite file size header mismatch (${fileSize} != ${actualFileSize})`);
  if (frames < 1) throw new Error('Aseprite file has no frames');
  if (width < 1 || height < 1) throw new Error('Aseprite canvas dimensions are invalid');
  if (![8, 16, 32].includes(depth)) throw new Error(`Aseprite color depth is unsupported: ${depth}`);
  return { fileSize, frames, width, height, depth };
}

async function readHeader(path: string): Promise<AsepriteHeader> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Source is not a regular file');
  const handle = await open(path, constants.O_RDONLY);
  try {
    const bytes = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, HEADER_BYTES, 0);
    return parseAsepriteHeader(bytes.subarray(0, bytesRead), info.size);
  } finally {
    await handle.close();
  }
}

function failure(code: string, message: string, dispatch: 'not_started' | 'completed',
  details?: Record<string, unknown>): ExecuteReceipt {
  return { status: 'failed', dispatch, code, message, ...(details ? { details } : {}) };
}

function capAppend(current: string, chunk: Buffer): string {
  if (current.length >= STDERR_LIMIT) return current;
  return (current + chunk.toString('utf8')).slice(0, STDERR_LIMIT);
}

async function runProcess(executable: string, args: string[], timeoutMs: number,
  signal: AbortSignal | undefined, spawnProcess: NonNullable<AsepriteAdapterOptions['spawnProcess']>): Promise<ProcessOutcome> {
  if (signal?.aborted) return { kind: 'spawn_error', message: 'Export cancelled before process start', stderr: '', stdout: '' };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    return { kind: 'spawn_error', message: error instanceof Error ? error.message : String(error), stderr: '', stdout: '' };
  }
  child.stdin.end();
  let spawned = false;
  let stderr = '';
  let stdout = '';
  let processError: string | undefined;
  let interrupted: 'timeout' | 'cancelled' | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  const outcome = await new Promise<ProcessOutcome>(resolveOutcome => {
    const finish = (value: ProcessOutcome): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      resolveOutcome(value);
    };
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = capAppend(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = capAppend(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('spawn', () => { spawned = true; });
    child.once('error', error => {
      if (spawned) processError = error.message;
      else finish({ kind: 'spawn_error', message: error.message, stderr, stdout });
    });
    child.once('close', (code, childSignal) => {
      if (interrupted) finish({ kind: 'interrupted', reason: interrupted, stderr, stdout });
      else if (processError) finish({ kind: 'process_error', message: processError, stderr, stdout });
      else finish({ kind: 'exit', code, signal: childSignal, stderr, stdout });
    });
    const stop = (reason: 'timeout' | 'cancelled'): void => {
      if (interrupted) return;
      interrupted = reason;
      try { child.kill(); } catch { /* Escalation below still attempts termination. */ }
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* close/error event determines the receipt */ }
        }
      }, KILL_ESCALATION_MS);
    };
    abortHandler = () => stop('cancelled');
    signal?.addEventListener('abort', abortHandler, { once: true });
    if (signal?.aborted) stop('cancelled');
    timer = setTimeout(() => stop('timeout'), timeoutMs);
  });
  return outcome;
}

function diagnosticDetails(stderr: string, artifactPath?: string, stdout?: string): Record<string, unknown> {
  return {
    ...(stderr ? { stderr: stderr.slice(0, STDERR_LIMIT) } : {}),
    ...(stdout ? { stdout: stdout.slice(0, STDERR_LIMIT) } : {}),
    ...(artifactPath ? { artifactPath } : {})
  };
}

export function createAsepritePngAdapter(options: AsepriteAdapterOptions = {}): WorkflowAdapter {
  const executable = resolve(options.executable ?? process.env.DP_ASEPRITE_EXE ?? ASEPRITE_EXE);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? spawn as AsepriteAdapterOptions['spawnProcess'];

  return {
    id: 'aseprite-png',
    version: 'aseprite-png-v1',

    async probe(source: WorkflowSource): Promise<ProbeResult> {
      if (!['.ase', '.aseprite'].includes(extname(source.relativePath).toLowerCase()))
        return { status: 'unsupported', code: 'unsupported_source_extension',
          message: 'Only .ase and .aseprite source files are supported' };
      let header: AsepriteHeader;
      try { header = await readHeader(resolve(source.absolutePath)); }
      catch (error) {
        return { status: 'failed', code: 'invalid_aseprite_source',
          message: error instanceof Error ? error.message : String(error) };
      }
      if (header.frames !== 1) return { status: 'unsupported', code: 'aseprite_animation_unsupported',
        message: `Only single-frame Aseprite documents are supported; this file has ${header.frames} frames` };
      if (header.width * header.height > MAX_VERIFY_PIXELS)
        return { status: 'unsupported', code: 'aseprite_dimensions_too_large',
          message: `Canvas exceeds the ${MAX_VERIFY_PIXELS.toLocaleString()}-pixel verification limit` };
      return { status: 'supported', expected: {
        format: 'aseprite', frames: header.frames, width: header.width, height: header.height,
        depth: header.depth, fileSize: header.fileSize
      } };
    },

    async execute(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<ExecuteReceipt> {
      const source = resolve(sourcePath);
      const destination = resolve(destinationPath);
      if (!['.ase', '.aseprite'].includes(extname(source).toLowerCase()))
        return failure('unsupported_source_extension', 'Only .ase and .aseprite source files are supported', 'not_started');
      let header: AsepriteHeader;
      try { header = await readHeader(source); }
      catch (error) {
        return failure('invalid_aseprite_source', error instanceof Error ? error.message : String(error), 'not_started');
      }
      if (header.frames !== 1) return failure('aseprite_animation_unsupported',
        `Only single-frame Aseprite documents are supported; this file has ${header.frames} frames`, 'not_started');
      if (header.width * header.height > MAX_VERIFY_PIXELS)
        return failure('aseprite_dimensions_too_large',
          `Canvas exceeds the ${MAX_VERIFY_PIXELS.toLocaleString()}-pixel verification limit`, 'not_started');
      if (signal?.aborted) return failure('cancelled', 'Export cancelled before process start', 'not_started');
      try {
        await lstat(destination);
        return failure('output_exists', 'Destination already exists; refusing to overwrite it', 'not_started', { destination });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          return failure('output_check_failed', error instanceof Error ? error.message : String(error), 'not_started', { destination });
      }

      const tempPath = resolve(dirname(destination), `${basename(destination)}.partial.png`);
      try {
        await lstat(tempPath);
        return failure('candidate_partial_exists', 'A prior partial candidate exists; reconcile it before another export',
          'not_started', { destination, artifactPath: tempPath });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          return failure('partial_check_failed', error instanceof Error ? error.message : String(error), 'not_started', { destination });
      }
      const args = ['--batch', source, '--save-as', tempPath];
      const outcome = await runProcess(executable, args, timeoutMs, signal, spawnProcess!);
      if (outcome.kind === 'spawn_error') {
        return failure(signal?.aborted ? 'cancelled' : 'aseprite_start_failed', outcome.message,
          'not_started', diagnosticDetails(outcome.stderr, undefined, outcome.stdout));
      }
      let retainedArtifact = tempPath;
      let commitErrorCode: string | undefined;
      try {
        await link(tempPath, destination);
        retainedArtifact = destination;
        try { await unlink(tempPath); } catch { /* The candidate link remains usable for core verification. */ }
      } catch (error) {
        commitErrorCode = (error as NodeJS.ErrnoException).code;
        if (commitErrorCode === 'ENOENT') retainedArtifact = '';
      }
      if (outcome.kind === 'interrupted') {
        return { status: 'unknown', dispatch: 'possibly_partial', code: outcome.reason === 'timeout' ? 'aseprite_timeout' : 'cancelled',
          message: outcome.reason === 'timeout' ? `Aseprite CLI exceeded ${timeoutMs} ms and was terminated` : 'Aseprite CLI was cancelled and terminated',
          details: { ...diagnosticDetails(outcome.stderr, retainedArtifact || undefined, outcome.stdout), candidatePath: destination } };
      }
      if (outcome.kind === 'process_error') {
        return { status: 'unknown', dispatch: 'unknown', code: 'aseprite_process_error', message: outcome.message,
          details: { ...diagnosticDetails(outcome.stderr, retainedArtifact || undefined, outcome.stdout), candidatePath: destination } };
      }
      if (outcome.code !== 0) {
        return failure('aseprite_export_failed', `Aseprite CLI exited with code ${outcome.code ?? outcome.signal ?? 'unknown'}`,
          'completed', { ...diagnosticDetails(outcome.stderr, retainedArtifact || undefined, outcome.stdout), candidatePath: destination });
      }
      if (!retainedArtifact || retainedArtifact !== destination) {
        const exists = commitErrorCode === 'EEXIST';
        return failure(exists ? 'output_exists' : retainedArtifact ? 'output_commit_failed' : 'aseprite_output_missing',
          exists ? 'Candidate path appeared during export; refusing to overwrite it' :
            retainedArtifact ? `Could not commit candidate without risking overwrite: ${commitErrorCode ?? 'unknown error'}` :
              'Aseprite exited successfully but did not produce a candidate PNG',
          'completed', { ...diagnosticDetails(outcome.stderr, retainedArtifact || undefined), candidatePath: destination });
      }
      return { status: 'completed', details: {
        producer: 'aseprite-cli', executable, destination, candidatePath: destination, sourceName: basename(source),
        ...(outcome.stderr ? { stderr: outcome.stderr } : {}),
        verification: 'deferred_to_workflow_core'
      } };
    },

    async verify(destinationPath: string, expected: Record<string, unknown>): Promise<VerificationEvidence> {
      const width = Number(expected.width), height = Number(expected.height);
      if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1)
        return { status: 'failed', verifier: 'aseprite-png-v1', expected, message: 'Expected source dimensions are missing or invalid' };
      return verifyPng(resolve(destinationPath), { width, height });
    }
  };
}

async function verifyPng(path: string, expected: { width: number; height: number }): Promise<VerificationEvidence> {
  try {
    if (expected.width * expected.height > MAX_VERIFY_PIXELS)
      throw new Error(`PNG exceeds the ${MAX_VERIFY_PIXELS.toLocaleString()}-pixel verification limit`);
    const info = await stat(path);
    if (!info.isFile() || info.size < 8) throw new Error('PNG output is missing or too small');
    const signatureHandle = await open(path, constants.O_RDONLY);
    let signature: Buffer;
    try {
      signature = Buffer.alloc(8);
      const read = await signatureHandle.read(signature, 0, 8, 0);
      signature = signature.subarray(0, read.bytesRead);
    } finally { await signatureHandle.close(); }
    if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Output does not have a PNG signature');
    const image = sharp(path, { failOn: 'warning', limitInputPixels: MAX_VERIFY_PIXELS });
    const metadata = await image.metadata();
    if (metadata.format !== 'png') throw new Error(`Expected PNG output; found ${metadata.format ?? 'unknown format'}`);
    if (metadata.width !== expected.width || metadata.height !== expected.height)
      throw new Error(`PNG dimensions mismatch: expected ${expected.width}x${expected.height}, found ${metadata.width}x${metadata.height}`);
    const alpha = metadata.hasAlpha === true;
    const stats = await sharp(path, { failOn: 'warning', limitInputPixels: MAX_VERIFY_PIXELS }).stats();
    let transparentPixelPossible: boolean | null = null;
    if (alpha) {
      const alphaChannel = stats.channels[3];
      transparentPixelPossible = Boolean(alphaChannel && alphaChannel.min < 255);
    }
    return { status: 'verified', verifier: 'aseprite-png-v1',
      expected: { format: 'png', width: expected.width, height: expected.height },
      actual: { format: metadata.format, width: metadata.width, height: metadata.height,
        bytes: info.size, alphaChannel: alpha, transparentPixelEvidence: transparentPixelPossible,
        claimScope: 'PNG signature, dimensions, and alpha-channel evidence only; image content equivalence is not verified' } };
  } catch (error) {
    return { status: 'failed', verifier: 'aseprite-png-v1', expected,
      message: error instanceof Error ? error.message : String(error) };
  }
}
