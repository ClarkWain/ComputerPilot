import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { controlFileWorkflowControl, resumeWorkflow, startWorkflow } from '../src/workflow/runtime.js';
import { TrustedScriptWorker } from '../src/workflow/script-worker.js';
import type { WorkflowAdapter, WorkflowConfig } from '../src/workflow/types.js';

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/workflow/cli.js');

function config(inputDirectory: string): WorkflowConfig {
  return { schemaVersion: 1, name: 'CLI subprocess test', inputDirectory,
    outputDirectory: 'artifacts', adapter: 'aseprite-png', executable: process.execPath,
    maxItems: 20, timeoutMs: 5000, onError: 'continue' };
}

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true });
}

function waitForChild(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolvePromise => child.once('close', code => resolvePromise(code)));
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await readFile(path); return; }
    catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 10)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function startHostedWorkflow(inputDirectory: string, runDirectory: string, markerPath: string): ChildProcess {
  const runtimeUrl = new URL('../src/workflow/runtime.js', import.meta.url).href;
  const configValue = config(inputDirectory);
  const source = `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { dirname } from 'node:path';
    import { setTimeout } from 'node:timers/promises';
    import { startWorkflow, controlFileWorkflowControl } from ${JSON.stringify(runtimeUrl)};
    const config = ${JSON.stringify(configValue)};
    const runDirectory = ${JSON.stringify(runDirectory)};
    const markerPath = ${JSON.stringify(markerPath)};
    const adapter = {
      id: 'aseprite-png', version: 'aseprite-png-v1',
      async probe() { return { status: 'supported', expected: { format: 'PNG' } }; },
      async execute(_source, destination) {
        await writeFile(markerPath, 'executing');
        await setTimeout(300);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, 'test-artifact');
        return { status: 'completed' };
      },
      async verify(destination) {
        return { status: 'verified', verifier: 'host-test', expected: { format: 'PNG' }, actual: { format: 'PNG' } };
      }
    };
    const report = await startWorkflow(config, adapter, runDirectory, { control: controlFileWorkflowControl(runDirectory) });
    process.stdout.write(JSON.stringify(report));
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

const fakeAdapter: WorkflowAdapter = {
  id: 'aseprite-png',
  version: 'aseprite-png-v1',
  async probe() { return { status: 'supported', expected: { format: 'PNG' } }; },
  async execute(_source, destination) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'test-artifact');
    return { status: 'completed' };
  },
  async verify(destination) {
    await readFile(destination);
    return { status: 'verified', verifier: 'cli-test', expected: { format: 'PNG' }, actual: { format: 'PNG' } };
  }
};

test('validate and plan run as real CLI subprocesses without importing the declared script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dp-workflow-cli-static-'));
  try {
    const input = join(root, 'input'); await mkdir(input);
    await writeFile(join(input, 'sprite.ase'), 'frozen-source');
    const script = join(root, 'broken-script.mjs');
    await writeFile(script, 'this is intentionally invalid JavaScript !!!');
    const configPath = join(root, 'workflow.json');
    await writeFile(configPath, JSON.stringify({ ...config(input), script }));

    const validated = runCli('validate', configPath);
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(validated.stderr, '');
    const validation = JSON.parse(validated.stdout);
    assert.equal(validation.ok, true);
    assert.equal(validation.inputCount, 1);

    const planned = runCli('plan', configPath);
    assert.equal(planned.status, 0, planned.stderr);
    const planResult = JSON.parse(planned.stdout);
    assert.equal(planResult.dynamicScriptLoaded, false);
    assert.equal(planResult.desktopInspected, false);
    assert.equal(planResult.plan.items[0].destinationRelativePath, 'sprite.png');
    assert.equal(planned.stdout.trim().split(/\r?\n/).length, 1, 'stdout must contain one JSON record');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('status subprocess rebuilds the report from a completed run journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dp-workflow-cli-status-'));
  try {
    const input = join(root, 'input'); await mkdir(input);
    await writeFile(join(input, 'sprite.ase'), 'frozen-source');
    const runDirectory = join(root, 'run');
    await startWorkflow(config(input), fakeAdapter, runDirectory);
    const status = runCli('status', runDirectory);
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.equal(report.status, 'completed');
    assert.equal(report.counts.completed, 1);
    assert.equal(report.items[0].status, 'completed');
    const events = (await readFile(join(runDirectory, 'execution.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(events.some(event => event.kind === 'item_commit'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trusted decision stdout cannot corrupt CLI stdout and a hung hook is killed after its deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dp-workflow-script-worker-'));
  let outputWorker: TrustedScriptWorker | undefined;
  let hangingWorker: TrustedScriptWorker | undefined;
  try {
    const loggingScript = join(root, 'logging.mjs');
    const loggingSource = `export default async function decideItem() { console.log('hook log'); return { decision: 'skip', reason: 'logged safely' }; }\n`;
    await writeFile(loggingScript, loggingSource);
    outputWorker = new TrustedScriptWorker(loggingScript, createHash('sha256').update(loggingSource).digest('hex'));
    const decision = await outputWorker.decideItem({ relativePath: 'sprite.ase', absolutePath: 'unused', size: 1, sha256: 'a'.repeat(64) },
      { status: 'supported', expected: { format: 'PNG' } });
    assert.deepEqual(decision, { decision: 'skip', reason: 'logged safely' });
    await outputWorker.close();

    const hangingScript = join(root, 'hanging.mjs');
    const hangingSource = `export default async function decideItem() { return await new Promise(() => {}); }\n`;
    await writeFile(hangingScript, hangingSource);
    hangingWorker = new TrustedScriptWorker(hangingScript, createHash('sha256').update(hangingSource).digest('hex'), 200);
    await assert.rejects(hangingWorker.decideItem({ relativePath: 'sprite.ase', absolutePath: 'unused', size: 1,
      sha256: 'b'.repeat(64) }, { status: 'supported', expected: {} }), /exceeded 200 ms/);

    const syncScript = join(root, 'sync-loop.mjs');
    const syncSource = `export default function decideItem() { while (true) {} }\n`;
    await writeFile(syncScript, syncSource);
    const syncWorker = new TrustedScriptWorker(syncScript, createHash('sha256').update(syncSource).digest('hex'), 200);
    try {
      await assert.rejects(syncWorker.decideItem({ relativePath: 'sprite.ase', absolutePath: 'unused', size: 1,
        sha256: 'c'.repeat(64) }, { status: 'supported', expected: {} }), /exceeded 200 ms/);
    } finally { await syncWorker.close(); }
  } finally {
    await outputWorker?.close(); await hangingWorker?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('each trusted item decision runs in a fresh module process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dp-workflow-script-isolation-'));
  let worker: TrustedScriptWorker | undefined;
  try {
    const input = join(root, 'input'); await mkdir(input);
    await writeFile(join(input, 'a.ase'), 'a'); await writeFile(join(input, 'b.ase'), 'b');
    const scriptPath = join(root, 'counter.mjs');
    const scriptSource = `let counter = 0; export default async function decideItem() { counter++; return { decision: 'skip', reason: String(counter) }; }\n`;
    await writeFile(scriptPath, scriptSource);
    const hash = createHash('sha256').update(scriptSource).digest('hex');
    worker = new TrustedScriptWorker(scriptPath, hash);
    await startWorkflow(config(input), fakeAdapter, join(root, 'run'), { trustedScript: worker });
    const events = (await readFile(join(root, 'run', 'execution.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const reasons = events.filter(event => event.kind === 'item_decision').map(event => event.reason);
    assert.deepEqual(reasons, ['1', '1']);
  } finally { await worker?.close(); await rm(root, { recursive: true, force: true }); }
});

test('trusted script hash mismatch is rejected before importing the replacement module', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dp-workflow-script-hash-'));
  try {
    const input = join(root, 'input'); await mkdir(input); await writeFile(join(input, 'a.ase'), 'a');
    const scriptPath = join(root, 'decision.mjs');
    const original = `export default async function decideItem() { return { decision: 'skip' }; }\n`;
    await writeFile(scriptPath, original);
    const originalHash = createHash('sha256').update(original).digest('hex');
    const trusted = { hash: originalHash, async decideItem() { return { decision: 'skip' as const }; } };
    const runDirectory = join(root, 'run');
    await startWorkflow(config(input), fakeAdapter, runDirectory, { trustedScript: trusted });
    const marker = join(root, 'imported.marker');
    const changed = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export default () => ({ decision: 'skip' });\n`;
    await writeFile(scriptPath, changed);
    const result = runCli('resume', runDirectory, '--trusted-script', scriptPath);
    assert.equal(result.status, 4, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'script_changed');
    await assert.rejects(readFile(marker));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pause and cancel CLI subprocesses take effect at the next item boundary', async () => {
  for (const request of ['pause', 'cancel'] as const) {
    const root = await mkdtemp(join(tmpdir(), `dp-workflow-${request}-`));
    let host: ChildProcess | undefined;
    try {
      const input = join(root, 'input'); await mkdir(input);
      await writeFile(join(input, 'a.ase'), 'a'); await writeFile(join(input, 'b.ase'), 'b');
      const runDirectory = join(root, 'run');
      const marker = join(root, 'first-item-started');
      host = startHostedWorkflow(input, runDirectory, marker);
      await waitForFile(marker);
      const control = runCli(request, runDirectory);
      assert.equal(control.status, 0, control.stderr);
      assert.equal(JSON.parse(control.stdout).request, request);
      assert.equal(await waitForChild(host), 0, 'hosted workflow should exit normally');
      const report = JSON.parse(runCli('status', runDirectory).stdout);
      assert.equal(report.status, request === 'pause' ? 'paused' : 'cancelled');
      assert.equal(report.counts.completed, 1);
      assert.equal(report.counts.not_started, 1);
      if (request === 'pause') {
        const resumed = await resumeWorkflow(fakeAdapter, runDirectory, { control: controlFileWorkflowControl(runDirectory) });
        assert.equal(resumed.status, 'completed', 'resume consumes the stale pause while holding the run lock');
      }
    } finally {
      if (host && host.exitCode === null) host.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('run announces its directory on stderr while preserving one JSON stdout record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dp-workflow-run-announcement-'));
  try {
    const input = join(root, 'input'); await mkdir(input); await writeFile(join(input, 'notes.txt'), 'unsupported by adapter');
    const configPath = join(root, 'workflow.json');
    await writeFile(configPath, JSON.stringify(config(input)));
    const runDirectory = join(root, 'run');
    const result = runCli('run', configPath, '--run-dir', runDirectory);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(runDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
    assert.equal(JSON.parse(result.stdout).runDirectory, runDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});
