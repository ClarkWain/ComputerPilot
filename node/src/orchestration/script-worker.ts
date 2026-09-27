import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AskArgs, CommandKind, CommandRequest, ObserveArgs, StepArgs, WaitArgs } from './types.js';

const marker = 'DP_ORCHESTRATION_WORKER';
const idPattern = /^[A-Za-z0-9_.-]{1,80}$/;
type Reply = { type: 'reply'; id: number; ok: boolean; value?: unknown; error?: string };

export type AuthorContext = {
  readInput<T = unknown>(id: string): Promise<T>;
  observe(id: string, args: ObserveArgs): Promise<unknown>;
  step(id: string, args: StepArgs): Promise<unknown>;
  waitFor(id: string, args: WaitArgs): Promise<unknown>;
  ask(id: string, args: AskArgs): Promise<string>;
  checkpoint(id: string, value?: unknown): Promise<void>;
  item<T>(key: string, body: (ctx: AuthorContext) => Promise<T>): Promise<T>;
  withDesktop<T>(key: string, body: (ctx: AuthorContext) => Promise<T>): Promise<T>;
};

async function runWorker(): Promise<void> {
  const [scriptPath, expectedHash] = process.argv.slice(2);
  if (!scriptPath || !/^[a-f0-9]{64}$/i.test(expectedHash ?? '') || !process.send)
    throw new Error('Orchestration worker arguments are invalid');
  const absolute = resolve(scriptPath);
  const hash = () => readFile(absolute).then(bytes => createHash('sha256').update(bytes).digest('hex'));
  if (await hash() !== expectedHash) throw new Error('Trusted workflow script changed before import');
  const module = await import(`${pathToFileURL(absolute).href}?sha256=${expectedHash}`) as { default?: unknown };
  if (await hash() !== expectedHash) throw new Error('Trusted workflow script changed while importing');
  if (typeof module.default !== 'function') throw new Error('Workflow script must default-export a function');

  let nextId = 0;
  let commandPending = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const reply = message as Reply;
    if (reply.type !== 'reply' || !Number.isInteger(reply.id)) return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.ok) waiter.resolve(reply.value);
    else waiter.reject(new Error(reply.error ?? 'Host command failed'));
  });
  const send = (request: Record<string, unknown>): Promise<unknown> => new Promise((resolvePromise, rejectPromise) => {
    const isCommand=request.type==='command';
    if (isCommand && commandPending) {
      rejectPromise(new Error('Workflow host commands must be awaited one at a time'));
      return;
    }
    if (isCommand) commandPending=true;
    const id = ++nextId;
    pending.set(id, { resolve: value => {if(isCommand)commandPending=false;resolvePromise(value);},
      reject: error => {if(isCommand)commandPending=false;rejectPromise(error);} });
    process.send?.({ ...request, id }, error => {
      if (error) { pending.delete(id);if(isCommand)commandPending=false;rejectPromise(error); }
    });
  });
  const named = (value: string): string => {
    if (!idPattern.test(value)) throw new Error(`Workflow command id must match ${idPattern}`);
    return value;
  };
  const context = (scope: string): AuthorContext => {
    const command = (kind: CommandKind, id: string, args: unknown) => send({ type: 'command',
      request: { kind, id: named(id), scope, args } satisfies CommandRequest });
    return {
      readInput: id => command('readInput', id, undefined) as Promise<never>,
      observe: (id, args) => command('observe', id, args),
      step: (id, args) => command('step', id, args),
      waitFor: (id, args) => command('waitFor', id, args),
      ask: (id, args) => command('ask', id, args) as Promise<string>,
      checkpoint: async (id, value) => { await command('checkpoint', id, value); },
      item: async (key, body) => body(context(`${scope}/item:${named(key)}`)),
      withDesktop: async (key, body) => {
        if (scope.includes('/desktop:')) throw new Error('withDesktop segments cannot be nested');
        const nested = `${scope}/desktop:${named(key)}`;
        try { return await body(context(nested)); }
        finally { await send({ type: 'desktop_end', scope: nested }); }
      }
    };
  };
  process.send({ type: 'ready' });
  process.once('message', async (message: unknown) => {
    if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'start') return;
    try {
      const value = await (module.default as (ctx: AuthorContext) => Promise<unknown>)(context('root'));
      process.send?.({ type: 'finished', value }, () => process.disconnect?.());
    } catch (error) {
      process.send?.({ type: 'fatal', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        () => process.disconnect?.());
    }
  });
}

if (process.env[marker] === '1') {
  runWorker().catch(error => {
    process.send?.({ type: 'fatal', error: error instanceof Error ? error.message : String(error) },
      () => process.disconnect?.());
    process.exitCode = 1;
  });
}

export const ORCHESTRATION_WORKER_MARKER = marker;
