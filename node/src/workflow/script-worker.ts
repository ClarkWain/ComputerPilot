import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProbeResult, TrustedWorkflowScript, WorkflowItemDecision, WorkflowSource } from './types.js';

export const WORKFLOW_SCRIPT_TIMEOUT_MS = 10_000;
const SCRIPT_LOG_LIMIT_BYTES = 64 * 1024;
const WORKER_MARKER = 'DP_WORKFLOW_SCRIPT_WORKER';

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

function normalizeDecision(value: unknown): WorkflowItemDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Script decision must be an object');
  const decision = value as Record<string, unknown>;
  if (decision.decision !== 'export' && decision.decision !== 'skip')
    throw new Error('Script decision must be "export" or "skip"');
  if (Object.keys(decision).some(key => !['decision', 'reason'].includes(key)))
    throw new Error('Script decision contains unsupported fields');
  if (decision.reason !== undefined && (typeof decision.reason !== 'string' || decision.reason.length > 2000))
    throw new Error('Script decision reason must be text of at most 2000 characters');
  return { decision: decision.decision, ...(decision.reason === undefined ? {} : { reason: decision.reason as string }) };
}

/** A fresh child per item keeps the decision function isolated and restart-safe. */
export class TrustedScriptWorker implements TrustedWorkflowScript {
  private closed = false;
  private active = false;
  private readonly children = new Set<ChildProcess>();
  private readonly closedChildren = new WeakSet<ChildProcess>();
  private logBytes = 0;
  private logLimitReported = false;

  constructor(readonly path: string, readonly hash: string, private readonly timeoutMs = WORKFLOW_SCRIPT_TIMEOUT_MS) {}

  async decideItem(source: WorkflowSource, probe: ProbeResult): Promise<WorkflowItemDecision> {
    if (this.closed) throw new Error('Trusted script runner is closed');
    if (this.active) throw new Error('Trusted script decisions must run one at a time');
    if (digest(await readFile(this.path)) !== this.hash) throw new Error('Trusted script changed while the workflow was running');
    const child = fork(fileURLToPath(import.meta.url), [this.path, this.hash], {
      execArgv: [], env: { ...process.env, [WORKER_MARKER]: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
    });
    this.active = true;
    this.children.add(child);
    child.once('close', () => this.closedChildren.add(child));
    this.pipeDiagnostic(child.stdout, 'stdout');
    this.pipeDiagnostic(child.stderr, 'stderr');

    return new Promise<WorkflowItemDecision>((resolvePromise, rejectPromise) => {
      let ready = false;
      let settled = false;
      let decision: WorkflowItemDecision | undefined;
      let failure: Error | undefined;
      let timer: NodeJS.Timeout;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        this.active = false;
        if (error) rejectPromise(error);
        else if (decision) resolvePromise(decision);
        else rejectPromise(new Error('Trusted script worker exited without a decision'));
      };
      const stopFor = async (error: Error) => {
        if (!failure) failure = error;
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await this.waitForClose(child);
        finish(failure);
      };
      const stopAfterDecision = async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await this.waitForClose(child);
        finish(failure);
      };
      timer = setTimeout(() => { void stopFor(new Error(`Trusted script decision exceeded ${this.timeoutMs} ms`)); }, this.timeoutMs);
      child.on('message', message => {
        if (!message || typeof message !== 'object') return;
        const event = message as Record<string, unknown>;
        if (!ready && event.kind === 'ready') {
          ready = true;
          child.send({ kind: 'decide', id: randomUUID(), source, probe }, error => {
            if (error) void stopFor(new Error(`Could not send item to trusted script: ${error.message}`));
          });
        } else if (event.kind === 'result') {
          if (event.ok === true) {
            try { decision = normalizeDecision(event.value); }
            catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
          } else failure = new Error(typeof event.error === 'string' ? event.error : 'Trusted script decision failed');
          child.disconnect();
          void stopAfterDecision();
        } else if (event.kind === 'fatal') {
          void stopFor(new Error(typeof event.error === 'string' ? event.error : 'Trusted script failed to load'));
        }
      });
      child.once('error', error => { void stopFor(error); });
      child.once('close', (code, signal) => {
        this.children.delete(child);
        finish(failure ?? (decision ? undefined : new Error(`Trusted script worker exited (${signal ?? code ?? 'unknown'})`)));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const children = [...this.children];
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(child => this.waitForClose(child)));
  }

  private pipeDiagnostic(stream: NodeJS.ReadableStream | null, source: string): void {
    if (!stream) return;
    stream.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.logBytes < SCRIPT_LOG_LIMIT_BYTES) {
        const allowed = data.subarray(0, SCRIPT_LOG_LIMIT_BYTES - this.logBytes);
        if (allowed.length) process.stderr.write(`[workflow-script ${source}] ${allowed.toString('utf8')}`);
        this.logBytes += allowed.length;
      }
      if (this.logBytes >= SCRIPT_LOG_LIMIT_BYTES && !this.logLimitReported) {
        this.logLimitReported = true;
        process.stderr.write('\n[workflow-script] further script output was discarded\n');
      }
    });
  }

  private async waitForClose(child: ChildProcess): Promise<void> {
    if (this.closedChildren.has(child)) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // `exit` is sufficient to prove the script process can no longer perform effects.
    // Node's later `close` event can be delayed by inherited or draining stdio handles.
    await new Promise<void>(resolvePromise => {
      const done = () => { child.off('exit', done); child.off('close', done); resolvePromise(); };
      child.once('exit', done);
      child.once('close', done);
    });
  }
}

async function runWorker(): Promise<void> {
  const [scriptPath, expectedHash] = process.argv.slice(2);
  if (!scriptPath || !expectedHash || !process.send) throw new Error('Trusted script worker arguments are invalid');
  const absolute = resolve(scriptPath);
  const hash = digest(await readFile(absolute));
  if (hash !== expectedHash) throw new Error('Trusted script hash changed before worker import');
  const module = await import(`${pathToFileURL(absolute).href}?sha256=${hash}`) as { default?: unknown };
  if (digest(await readFile(absolute)) !== hash) throw new Error('Trusted script changed while importing');
  const exported = module.default;
  const decideItem = typeof exported === 'function' ? exported :
    exported && typeof exported === 'object' ? (exported as { decideItem?: unknown }).decideItem : undefined;
  if (typeof decideItem !== 'function') throw new Error('Trusted script must default-export a function or { decideItem(source, probe) }');
  process.send({ kind: 'ready' });
  process.on('message', async message => {
    if (!message || typeof message !== 'object') return;
    const event = message as Record<string, unknown>;
    if (event.kind !== 'decide' || typeof event.id !== 'string') return;
    try {
      const result = await (decideItem as (source: WorkflowSource, probe: ProbeResult) => unknown | Promise<unknown>)(
        event.source as WorkflowSource, event.probe as ProbeResult);
      process.send?.({ kind: 'result', id: event.id, ok: true, value: normalizeDecision(result) }, () => process.disconnect?.());
    } catch (error) {
      process.send?.({ kind: 'result', id: event.id, ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, () => process.disconnect?.());
    }
  });
}

if (process.env[WORKER_MARKER] === '1') {
  runWorker().catch(error => {
    process.send?.({ kind: 'fatal', error: error instanceof Error ? error.message : String(error) }, () => process.disconnect?.());
    process.exitCode = 1;
  });
}
