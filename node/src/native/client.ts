import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type JsonObject = Record<string, unknown>;
export type NativeCallOptions = { timeoutMs?: number; signal?: AbortSignal };
export type NativeHello = { protocolVersion: 1; operations: string[]; processId: number; preflight: JsonObject };
export type DispatchState = 'not_started' | 'unknown' | 'possibly_partial';

export class NativeCallError extends Error {
  constructor(public readonly code: string, message: string, public readonly dispatch: DispatchState,
    public readonly referencesInvalidated = false, public readonly details: JsonObject = {}) { super(message); this.name = 'NativeCallError'; }
  toResult(): JsonObject { return { status: 'error', code: this.code, message: this.message, dispatch: this.dispatch,
    ...this.details,
    ...(this.referencesInvalidated ? { referencesInvalidated: true,
      next: 'Worker references were invalidated. Call list_windows and inspect again; check prior input outcome before continuing.' } : {}) }; }
}

type Pending = { id: number; resolve: (value: JsonObject) => void; reject: (error: NativeCallError) => void;
  timer: NodeJS.Timeout; cleanup: () => void; dispatched: boolean };

/** Serial JSONL transport. Killing an unresponsive worker invalidates every native reference. */
export class NativeClient {
  private child?: ChildProcessWithoutNullStreams;
  private active?: Pending;
  private tail: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private stopped = false;
  private hello?: NativeHello;
  generation = 0;
  constructor(private readonly executable: string, private readonly args: string[] = []) {}
  get preflight(): JsonObject | undefined { return this.hello?.preflight; }
  get operations(): readonly string[] { return this.hello?.operations ?? []; }

  async start(): Promise<NativeHello> {
    if (this.stopped) throw new NativeCallError('worker_closed', 'Native client is closed', 'not_started');
    if (this.child && this.hello) return this.hello;
    if (this.child) throw new NativeCallError('worker_starting', 'Native worker is starting', 'not_started');
    const child = spawn(this.executable, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.generation++;
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => this.receive(child, line));
    child.on('error', error => this.failWorker(child, 'worker_start_failed', error.message));
    child.on('exit', (code, signal) => this.failWorker(child, 'worker_exited', `Native worker exited (${code ?? signal ?? 'unknown'})`));
    try {
      const value = await this.send('native.hello', {}, { timeoutMs: 10000 });
      if (value.protocolVersion !== 1 || !Array.isArray(value.operations) ||
          !value.operations.every(x => typeof x === 'string') || typeof value.processId !== 'number' ||
          !value.preflight || typeof value.preflight !== 'object') {
        this.failWorker(child, 'incompatible_native_protocol', 'Invalid native.hello response');
        throw new NativeCallError('incompatible_native_protocol', 'Invalid native.hello response', 'not_started', true);
      }
      this.hello = value as NativeHello;
      return this.hello;
    } catch (error) {
      this.failWorker(child, 'worker_start_failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async call(operation: string, args: JsonObject = {}, options: NativeCallOptions = {}): Promise<JsonObject> {
    const enqueuedGeneration=this.generation;
    const run = async (): Promise<JsonObject> => {
      if (enqueuedGeneration!==0 && this.generation!==enqueuedGeneration)
        throw new NativeCallError('references_invalidated','Worker changed before this queued call started; inspect again',
          'not_started',true);
      if (options.signal?.aborted) throw new NativeCallError('cancelled', 'Cancelled before dispatch', 'not_started');
      await this.start();
      if (!this.operations.includes(operation)) throw new NativeCallError('unsupported_native_operation', operation, 'not_started');
      return this.send(operation, args, options);
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private send(operation: string, args: JsonObject, options: NativeCallOptions): Promise<JsonObject> {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new NativeCallError('worker_unavailable', 'Native worker unavailable', 'not_started', true);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let onAbort = () => {};
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => this.failWorker(child, 'native_timeout', `${operation} timed out`), options.timeoutMs ?? 60000);
      this.active = { id, resolve, reject, timer, cleanup, dispatched: false };
      onAbort = () => this.failWorker(child, 'cancelled', `${operation} cancelled`);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) { onAbort(); return; }
      child.stdin.write(JSON.stringify({ id, operation, args }) + '\n', error => {
        if (error) this.failWorker(child, 'native_pipe_error', error.message);
      });
      if (this.active?.id === id) this.active.dispatched = true;
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.child) return;
    let response: JsonObject;
    try { response = JSON.parse(line) as JsonObject; }
    catch { this.failWorker(child, 'native_protocol_error', 'Native worker emitted invalid JSON'); return; }
    if (!response || typeof response!=='object' || Array.isArray(response)) {
      this.failWorker(child, 'native_protocol_error', 'Native worker emitted a non-object response'); return;
    }
    const pending = this.active;
    if (!pending || response.id !== pending.id || ('result' in response) === ('error' in response)) {
      this.failWorker(child, 'native_protocol_error', 'Unexpected native response'); return;
    }
    if (response.error && typeof response.error === 'object') {
      this.active = undefined; clearTimeout(pending.timer); pending.cleanup();
      const e = response.error as JsonObject;
      const dispatch:DispatchState=e.dispatch==='not_started'||e.dispatch==='possibly_partial'||e.dispatch==='unknown'
        ? e.dispatch : pending.dispatched?'unknown':'not_started';
      const details={...e};delete details.code;delete details.message;delete details.dispatch;
      pending.reject(new NativeCallError(String(e.code ?? 'native_error'), String(e.message ?? 'Native operation failed'),dispatch,false,details));
    } else if (response.result && typeof response.result === 'object' && !Array.isArray(response.result)) {
      this.active = undefined; clearTimeout(pending.timer); pending.cleanup();
      pending.resolve(response.result as JsonObject);
    } else this.failWorker(child, 'native_protocol_error', 'Native result must be an object');
  }

  private failWorker(child: ChildProcessWithoutNullStreams, code: string, message: string): void {
    if (child !== this.child) return;
    this.child = undefined; this.hello = undefined; this.generation++;
    const pending = this.active; this.active = undefined;
    if (pending) {
      clearTimeout(pending.timer); pending.cleanup();
      pending.reject(new NativeCallError(code, message, pending.dispatched ? 'unknown' : 'not_started', true));
    }
    child.kill();
  }

  close(): void {
    this.stopped = true;
    if (this.child) this.failWorker(this.child, 'worker_closed', 'Native client closed');
  }
}
