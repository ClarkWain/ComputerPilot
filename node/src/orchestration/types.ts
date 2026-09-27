import type { ReplayAction, ReplayCondition } from '../replay/recipe.js';

export type Target = { titleContains: string; pid?: number };
export type ObserveArgs = { target: Target };
export type ControlSelector = { name: string; role?: string };
export type BatchAction =
  | { type: 'click'; control: ControlSelector; count?: 1|2 }
  | { type: 'fill_text'; control: ControlSelector; text: string }
  | { type: 'type_text'; text: string }
  | { type: 'press_keys'; chord: string };
export type StepArgs = { target: Target; before: ReplayCondition; expect: ReplayCondition; timeoutMs?: number } & (
  { mode?: 'semantic'; profile: string; actions: ReplayAction[] } |
  { mode: 'batch'; actions: BatchAction[] });
export type WaitArgs = { target: Target; expect: ReplayCondition; timeoutMs: number };
export type AskArgs = { question: string; choices: string[] };
export type CommandKind = 'readInput' | 'observe' | 'step' | 'waitFor' | 'ask' | 'checkpoint';
export type CommandRequest = { kind: CommandKind; id: string; scope: string; args: unknown };
export type CommandResult = unknown;
export type OrchestrationDefinition = { schemaVersion: 1; name: string; script: string;
  scriptSha256: string; input: unknown; inputSha256: string; createdAt: string };
export type OrchestrationEvent = { seq: number; time: string; kind: string; [key: string]: unknown };
export type OrchestrationStatus = 'running' | 'paused' | 'cancelled' | 'completed' |
  'waiting_decision' | 'needs_reconciliation' | 'failed';
export type OrchestrationReport = { schemaVersion: 1; name: string; status: OrchestrationStatus;
  commandCount: number; committedCount: number; pending?: { key: string; kind: CommandKind; args: unknown };
  message?: string; runDirectory: string };
export type OrchestrationHost = {
  execute(request: CommandRequest): Promise<CommandResult>;
  releaseDesktop?(): Promise<void>;
};
