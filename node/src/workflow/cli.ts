import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkflowConfig, WorkflowReport, TrustedWorkflowScript } from './types.js';
import { createPlan } from './plan.js';
import { getWorkflowStatus } from './recovery.js';
import { controlFileWorkflowControl, reconcileWorkflow, resumeWorkflow, startWorkflow } from './runtime.js';
import { createAsepritePngAdapter } from './adapters/aseprite.js';
import { TrustedScriptWorker } from './script-worker.js';

const EXIT_OK = 0;
const EXIT_RUN_INCOMPLETE = 1;
const EXIT_USAGE = 2;
const EXIT_ENVIRONMENT = 3;
const EXIT_CONFLICT = 4;

class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = EXIT_USAGE,
    readonly details?: unknown) { super(message); }
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseArgs(argv: string[]): { command: string; positionals: string[]; options: Map<string, string | true> } {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i]!;
    if (!item.startsWith('--')) { positionals.push(item); continue; }
    const name = item.slice(2);
    if (!name || options.has(name)) throw new CliError('invalid_arguments', `Invalid or repeated option: ${item}`);
    if (['trusted-script', 'run-dir', 'reason'].includes(name)) {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new CliError('invalid_arguments', `--${name} requires a value`);
      options.set(name, value);
    } else if (name === 'json' || name === 'acknowledge') options.set(name, true);
    else throw new CliError('invalid_arguments', `Unknown option: ${item}`);
  }
  return { command: command ?? '', positionals, options };
}

function usage(): string {
  return 'Usage: workflow <validate|plan|run|status|resume|pause|cancel|reconcile> ...\n' +
    '  validate <workflow.json>\n  plan <workflow.json>\n' +
    '  run <workflow.json> [--run-dir <new-directory>] [--trusted-script <module.js>]\n' +
    '  status <run-dir>\n  resume <run-dir> [--trusted-script <same-module.js>]\n' +
    '  pause|cancel <run-dir>\n  reconcile <run-dir> <item-id> accept --reason <text>\n' +
    '  reconcile <run-dir> <item-id> skip --reason <text> --acknowledge';
}

function parseConfig(raw: unknown, sourcePath: string): WorkflowConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CliError('invalid_config', 'Workflow config must be a JSON object');
  const value = raw as Record<string, unknown>;
  const allowed = ['schemaVersion', 'name', 'inputDirectory', 'outputDirectory', 'adapter', 'executable', 'maxItems', 'timeoutMs', 'onError', 'script'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new CliError('invalid_config', `Unknown config field: ${key}`);
  if (value.schemaVersion !== 1) throw new CliError('invalid_config', 'schemaVersion must be 1');
  for (const key of ['name', 'inputDirectory', 'executable'] as const)
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new CliError('invalid_config', `${key} must be nonempty text`);
  if (value.adapter !== 'aseprite-png') throw new CliError('unsupported_adapter', 'Only adapter "aseprite-png" is available in this workflow version', EXIT_ENVIRONMENT);
  if (value.onError !== 'stop' && value.onError !== 'continue') throw new CliError('invalid_config', 'onError must be "stop" or "continue"');
  if (value.outputDirectory !== undefined && value.outputDirectory !== 'artifacts')
    throw new CliError('unsupported_output_directory', 'Version 1 stores outputs under <run-dir>/artifacts; outputDirectory must be omitted or "artifacts"');
  if (value.maxItems !== undefined && (!Number.isInteger(value.maxItems) || Number(value.maxItems) < 1 || Number(value.maxItems) > 20000))
    throw new CliError('invalid_config', 'maxItems must be an integer from 1 to 20000');
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 1800000))
    throw new CliError('invalid_config', 'timeoutMs must be an integer from 1000 to 1800000');
  if (value.script !== undefined && typeof value.script !== 'string') throw new CliError('invalid_config', 'script must be a relative module path');
  const configPath = resolve(sourcePath);
  const base = dirname(configPath);
  const resolveConfigPath = (text: string) => isAbsolute(text) ? resolve(text) : resolve(base, text);
  return {
    schemaVersion: 1,
    name: value.name as string,
    inputDirectory: resolveConfigPath(value.inputDirectory as string),
    ...(value.outputDirectory ? { outputDirectory: value.outputDirectory as string } : {}),
    adapter: 'aseprite-png',
    executable: resolveConfigPath(value.executable as string),
    ...(value.maxItems === undefined ? {} : { maxItems: value.maxItems as number }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }),
    onError: value.onError,
    ...(value.script === undefined ? {} : { script: resolveConfigPath(value.script as string) })
  };
}

async function loadConfig(path: string): Promise<WorkflowConfig> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch (error) { throw new CliError('config_read_failed', `Cannot read workflow JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return parseConfig(raw, path);
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function loadTrustedScript(path: string, expectedHash?: string): Promise<TrustedScriptWorker> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new CliError('script_not_found', `Trusted script does not exist: ${absolute}`);
  const hash = await hashFile(absolute);
  if (expectedHash && hash !== expectedHash)
    throw new CliError('script_changed', 'Trusted script hash differs from the frozen run plan; create a new run.', EXIT_CONFLICT);
  return new TrustedScriptWorker(absolute, hash);
}

function adapterFor(config: WorkflowConfig) {
  return createAsepritePngAdapter({ executable: config.executable, timeoutMs: config.timeoutMs });
}

async function writeControl(runDirectory: string, request: 'pause' | 'cancel'): Promise<void> {
  const directory = resolve(runDirectory);
  if (!existsSync(join(directory, 'execution.jsonl')) || !existsSync(join(directory, 'plan.json')))
    throw new CliError('run_not_found', 'Run directory does not contain a workflow run', EXIT_ENVIRONMENT);
  const lock = join(directory, 'control.lock');
  const deadline = Date.now() + 2000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new CliError('control_busy', 'Workflow control channel is busy; retry shortly.', EXIT_CONFLICT);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
  }
  const destination = join(directory, 'control.json');
  const temporary = join(directory, `.control-${randomUUID()}.tmp`);
  try {
    const report = await getWorkflowStatus(directory);
    if (report.status !== 'running')
      throw new CliError('run_not_active', `Control requests require a running workflow; current status is ${report.status}.`, EXIT_CONFLICT);
    await writeFile(temporary, `${JSON.stringify({ request })}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  finally { await rmdir(lock); }
}

function exitForReport(report: WorkflowReport): number {
  if (report.status === 'completed') return EXIT_OK;
  if (report.status === 'paused' || report.status === 'cancelled' || report.status === 'needs_reconciliation' ||
      report.status === 'completed_with_errors' || report.status === 'failed') return EXIT_RUN_INCOMPLETE;
  return EXIT_OK;
}

function defaultRunDir(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workflow';
  return resolve('workflow-runs', `${slug}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`);
}

async function execute(argv: string[]): Promise<{ result: unknown; exitCode: number }> {
  const { command, positionals, options } = parseArgs(argv);
  const expectedPositionals: Record<string, number> = { validate: 1, plan: 1, run: 1, status: 1, resume: 1, pause: 1, cancel: 1, reconcile: 3 };
  if (!(command in expectedPositionals) || positionals.length !== expectedPositionals[command])
    throw new CliError('usage', usage(), EXIT_USAGE);
  if (['validate', 'plan', 'status', 'pause', 'cancel', 'reconcile'].includes(command) && options.has('trusted-script'))
    throw new CliError('invalid_arguments', '--trusted-script is accepted only by run and resume');

  if (command === 'validate' || command === 'plan') {
    for (const key of options.keys()) if (key !== 'json') throw new CliError('invalid_arguments', `Unknown option: --${key}`);
    const config = await loadConfig(positionals[0]!);
    const plan = await createPlan(config);
    const result = command === 'validate'
      ? { ok: true, command, name: config.name, adapter: config.adapter, inputCount: plan.items.length, planHash: plan.planHash,
          inputDirectory: config.inputDirectory, outputDirectory: '<run-dir>/artifacts', requiresAseprite: config.executable }
      : { ok: true, command, plan, outputDirectory: '<new-run-dir>/artifacts', dynamicScriptLoaded: false,
          desktopInspected: false };
    return { result, exitCode: EXIT_OK };
  }
  if (command === 'status') {
    for (const key of options.keys()) if (key !== 'json') throw new CliError('invalid_arguments', `Unknown option: --${key}`);
    try { return { result: await getWorkflowStatus(resolve(positionals[0]!)), exitCode: EXIT_OK }; }
    catch (error) { throw new CliError('status_failed', error instanceof Error ? error.message : String(error), EXIT_ENVIRONMENT); }
  }
  if (command === 'pause' || command === 'cancel') {
    for (const key of options.keys()) if (key !== 'json') throw new CliError('invalid_arguments', `Unknown option: --${key}`);
    await writeControl(positionals[0]!, command);
    return { result: { ok: true, command, runDirectory: resolve(positionals[0]!), request: command,
      effectiveAt: 'next item boundary', currentItemMayFinish: true }, exitCode: EXIT_OK };
  }
  if (command === 'reconcile') {
    const [runDirectory, itemId, action] = positionals;
    const reason = options.get('reason');
    const expectedOptionCount = (action === 'skip' ? 2 : 1) + (options.has('json') ? 1 : 0);
    if (options.size !== expectedOptionCount || typeof reason !== 'string' || !['accept', 'skip'].includes(action) || !reason.trim() ||
      (action === 'skip' && options.get('acknowledge') !== true))
      throw new CliError('invalid_arguments', usage());
    const runPath = resolve(runDirectory!);
    const frozenPlan = JSON.parse(await readFile(join(runPath, 'plan.json'), 'utf8')) as { workflow: WorkflowConfig };
    let report: WorkflowReport;
    try {
      report = await reconcileWorkflow(runPath, itemId!, { action: action as 'accept' | 'skip', reason: reason!,
        ...(action === 'skip' ? { acknowledged: true } : {}) }, adapterFor(frozenPlan.workflow));
    } catch (error) {
      throw new CliError('reconciliation_conflict', error instanceof Error ? error.message : String(error), EXIT_CONFLICT);
    }
    return { result: report, exitCode: exitForReport(report) };
  }
  if (command === 'run') {
    const config = await loadConfig(positionals[0]!);
    const requested = options.get('run-dir');
    if (requested === true) throw new CliError('invalid_arguments', '--run-dir requires a path');
    for (const key of options.keys()) if (!['trusted-script', 'run-dir', 'json'].includes(key)) throw new CliError('invalid_arguments', `Unknown option: --${key}`);
    const trustedScriptPath = options.get('trusted-script');
    if (config.script && !trustedScriptPath) throw new CliError('trusted_script_required', `Config names a script. Pass --trusted-script ${config.script} to execute it.`);
    if (config.script && trustedScriptPath && resolve(String(trustedScriptPath)) !== resolve(config.script))
      throw new CliError('script_path_mismatch', 'The explicitly trusted script path differs from the path declared in config.');
    const script = trustedScriptPath ? await loadTrustedScript(String(trustedScriptPath)) : undefined;
    const runDirectory = requested ? resolve(String(requested)) : defaultRunDir(config.name);
    process.stderr.write(`[workflow] run directory: ${runDirectory} (it may not exist if startup fails)\n`);
    let report: WorkflowReport;
    try { report = await startWorkflow(config, adapterFor(config), runDirectory, { trustedScript: script, control: controlFileWorkflowControl(runDirectory) }); }
    catch (error) { throw new CliError('run_failed', error instanceof Error ? error.message : String(error), EXIT_RUN_INCOMPLETE, { runDirectory }); }
    finally { await script?.close(); }
    return { result: { ...report, runDirectory, artifactDirectory: join(runDirectory, 'artifacts') }, exitCode: exitForReport(report) };
  }
  if (command === 'resume') {
    const runDirectory = resolve(positionals[0]!);
    for (const key of options.keys()) if (!['trusted-script', 'json'].includes(key)) throw new CliError('invalid_arguments', `Unknown option: --${key}`);
    const frozenPlan = JSON.parse(await readFile(join(runDirectory, 'plan.json'), 'utf8')) as { workflow: WorkflowConfig; scriptHash?: string };
    const scriptPath = options.get('trusted-script');
    if (frozenPlan.scriptHash && !scriptPath) throw new CliError('trusted_script_required', 'This run requires its original trusted script; pass --trusted-script <same-module.js>.', EXIT_CONFLICT);
    if (!frozenPlan.scriptHash && scriptPath) throw new CliError('unexpected_trusted_script', 'This run was created without a trusted script.', EXIT_CONFLICT);
    const trustedScript = scriptPath ? await loadTrustedScript(String(scriptPath), frozenPlan.scriptHash) : undefined;
    let report: WorkflowReport;
    try { report = await resumeWorkflow(adapterFor(frozenPlan.workflow), runDirectory,
      { trustedScript, control: controlFileWorkflowControl(runDirectory) }); }
    catch (error) { throw new CliError('resume_conflict', error instanceof Error ? error.message : String(error), EXIT_CONFLICT); }
    finally { await trustedScript?.close(); }
    return { result: { ...report, runDirectory, artifactDirectory: join(runDirectory, 'artifacts') }, exitCode: exitForReport(report) };
  }
  throw new CliError('usage', usage(), EXIT_USAGE);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const { result, exitCode } = await execute(argv);
    output(result);
    process.exitCode = exitCode;
  } catch (error) {
    const cli = error instanceof CliError ? error : new CliError('workflow_error', error instanceof Error ? error.message : String(error), EXIT_ENVIRONMENT);
    output({ ok: false, error: { code: cli.code, message: cli.message, ...(cli.details === undefined ? {} : { details: cli.details }) } });
    process.exitCode = cli.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
