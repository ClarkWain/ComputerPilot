import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isWithin, outputRelativePath, pathKey, sha256File, snapshotInputFiles } from './paths.js';
import type { WorkflowConfig, WorkflowPlan, WorkflowPlanItem } from './types.js';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Workflow JSON cannot contain non-finite numbers');
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Workflow JSON contains an unsupported value');
  return encoded;
}

export const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex');
export const WORKFLOW_ADAPTER_VERSIONS:Record<WorkflowConfig['adapter'],string>={ 'aseprite-png':'aseprite-png-v1' };
export function computePlanHash(plan:Omit<WorkflowPlan,'planHash'>|WorkflowPlan):string {
  const { planHash:_planHash, createdAt:_createdAt, ...base } = plan as WorkflowPlan;
  return sha256Text(stableJson(base));
}

export async function validateWorkflowConfig(config: WorkflowConfig): Promise<WorkflowConfig> {
  if (!record(config) || config.schemaVersion !== 1) throw new Error('Unsupported workflow schemaVersion');
  const allowed = ['schemaVersion','name','inputDirectory','outputDirectory','adapter','executable','maxItems','timeoutMs','onError','script'];
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw new Error(`Unknown workflow config field: ${key}`);
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('name must be nonempty text');
  if (config.adapter !== 'aseprite-png') throw new Error(`Unsupported adapter: ${String(config.adapter)}`);
  if (config.onError !== 'stop' && config.onError !== 'continue') throw new Error('onError must be stop or continue');
  const inputCandidate = resolve(config.inputDirectory);
  const inputInfo = await lstat(inputCandidate);
  if (inputInfo.isSymbolicLink() || !inputInfo.isDirectory()) throw new Error('inputDirectory must be a real directory, not a link');
  const inputDirectory = await realpath(inputCandidate);
  if (!isAbsolute(config.executable)) throw new Error('executable must be an absolute path');
  const executable = await realpath(config.executable);
  const executableInfo = await stat(executable);
  if (!executableInfo.isFile()) throw new Error('executable must name a file');
  if (config.outputDirectory !== undefined && config.outputDirectory !== 'artifacts')
    throw Object.assign(new Error('Independent outputDirectory is not supported yet; outputs are written to runDirectory/artifacts'),
      { code: 'output_directory_unsupported' });
  const maxItems = config.maxItems ?? 500;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 20_000) throw new Error('maxItems must be 1..20000');
  const timeoutMs = config.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000)
    throw new Error('timeoutMs must be 1000..1800000');
  if (config.script !== undefined && (typeof config.script !== 'string' || !config.script.trim()))
    throw new Error('script must be a nonempty path when provided');
  return { schemaVersion: 1, name: config.name.trim(), inputDirectory, outputDirectory: 'artifacts',
    adapter: config.adapter, executable, maxItems, timeoutMs, onError: config.onError,
    ...(config.script ? { script: resolve(config.script) } : {}) };
}

export async function createPlan(config: WorkflowConfig, options: { scriptHash?: string } = {}): Promise<WorkflowPlan> {
  const normalized = await validateWorkflowConfig(config);
  if (options.scriptHash && !/^[a-f0-9]{64}$/i.test(options.scriptHash))
    throw new Error('scriptHash must be a SHA-256 digest');
  const sources = await snapshotInputFiles(normalized.inputDirectory, normalized.maxItems ?? 500);
  const executableSha256=await sha256File(normalized.executable);
  const outputs = new Map<string, string>();
  const items: WorkflowPlanItem[] = sources.map(source => {
    const destinationRelativePath = outputRelativePath(source.relativePath);
    const key = destinationRelativePath.replaceAll('\\', '/').toLocaleLowerCase('en-US');
    const previous = outputs.get(key);
    if (previous) throw Object.assign(new Error(`Output path collision: ${previous} and ${source.relativePath} both map to ${destinationRelativePath}`),
      { code: 'output_path_collision' });
    outputs.set(key, source.relativePath);
    return { id: `item-${sha256Text(source.relativePath.replaceAll('\\','/').toLocaleLowerCase('en-US')).slice(0,20)}`,
      source, destinationRelativePath };
  });
  const createdAt = new Date().toISOString();
  const planBase = { schemaVersion: 1 as const, workflow: normalized, ...(options.scriptHash ? { scriptHash: options.scriptHash.toLowerCase() } : {}),
    executableSha256, adapterVersion:WORKFLOW_ADAPTER_VERSIONS[normalized.adapter], createdAt, items };
  return { ...planBase, planHash: computePlanHash(planBase) };
}
