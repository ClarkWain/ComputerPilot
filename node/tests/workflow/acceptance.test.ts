import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { startWorkflow, resumeWorkflow, getWorkflowStatus, reconcileWorkflow } from '../../src/workflow/runtime.js';
import { createPlan } from '../../src/workflow/plan.js';
import type { WorkflowAdapter, WorkflowConfig } from '../../src/workflow/types.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(count = 3) {
  const root = await mkdtemp(join(tmpdir(), 'dp-workflow-independent-'));
  const input = join(root, 'input'); await mkdir(input);
  for (let i = 0; i < count; i++) await writeFile(join(input, `${i}.aseprite`), `source-${i}`);
  const config: WorkflowConfig = { schemaVersion: 1, name: 'Independent acceptance', inputDirectory: input,
    executable: process.execPath, adapter: 'aseprite-png', onError: 'continue', maxItems: 100 };
  const run = join(root, 'run');
  return { root, input, config, run, async cleanup() {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  } };
}
function fakeAdapter(calls: string[]): WorkflowAdapter {
  return { id: 'aseprite-png', version: 'aseprite-png-v1',
    async probe(source) { return { status: 'supported', expected: { value: (await readFile(source.absolutePath, 'utf8')) } }; },
    async execute(source, output) { calls.push(source); await writeFile(output, await readFile(source)); return { status: 'completed' }; },
    async verify(output, expected) { return { status: (await readFile(output, 'utf8')) === expected.value ? 'verified' : 'failed',
      verifier: 'independent-byte-check', expected }; }
  };
}
async function child(code: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', code],
      { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => processChild.kill(), 20_000);
    processChild.stderr.on('data', chunk => { stderr += chunk; });
    processChild.on('error', error => { clearTimeout(timer); rejectChild(error); });
    processChild.on('close', exitCode => { clearTimeout(timer); resolveChild({ code: exitCode, stderr }); });
  });
}

test('independent U06: pause after a committed item then resume without duplicate dispatch', async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const adapter = fakeAdapter(calls);
    const paused = await startWorkflow(f.config, adapter, f.run,
      { control: { async getRequest() { return calls.length === 1 ? 'pause' : undefined; } } });
    assert.equal(paused.status, 'paused'); assert.equal(paused.counts.completed, 1);
    assert.equal(paused.counts.not_started, 2);
    const first = join(f.run, 'artifacts', '0.png');
    const firstTime = (await stat(first)).mtimeMs;
    const result = await resumeWorkflow(adapter, f.run);
    assert.equal(result.status, 'completed'); assert.equal(result.counts.completed, 3);
    assert.equal(calls.length, 3); assert.equal(new Set(calls).size, 3);
    assert.equal((await stat(first)).mtimeMs, firstTime);
  } finally { await f.cleanup(); }
});

test('independent U05: a changed frozen source is not dispatched when continuing other items', async () => {
  const f = await fixture();
  try {
    const calls: string[] = []; const adapter = fakeAdapter(calls);
    await startWorkflow(f.config, adapter, f.run, { control: { async getRequest() { return 'pause'; } } });
    await writeFile(join(f.input, '0.aseprite'), 'changed after planning');
    const result = await resumeWorkflow(adapter, f.run);
    assert.notEqual(result.status, 'completed');
    const changed = result.items.find(item => item.sourceRelativePath === '0.aseprite')!;
    assert.ok(['failed', 'conflict', 'needs_reconciliation'].includes(changed.status));
    assert.equal(calls.includes(join(f.input, '0.aseprite')), false);
  } finally { await f.cleanup(); }
});

test('independent U07/U16: abrupt producer death preserves unknown intent and requires explicit reconciliation', async () => {
  const f = await fixture(1);
  try {
    const moduleUrl = new URL('../../src/workflow/runtime.js', import.meta.url).href;
    const script = `import { startWorkflow } from ${JSON.stringify(moduleUrl)};
      import {readFile,writeFile} from 'node:fs/promises';
      const adapter={id:'aseprite-png',version:'aseprite-png-v1',probe:async source=>({status:'supported',expected:{value:await readFile(source.absolutePath,'utf8')}}),
      execute:async(source,output)=>{await writeFile(output,await readFile(source));process.exit(73);},
      verify:async()=>{throw new Error('never reaches verification');}};
      await startWorkflow(${JSON.stringify(f.config)},adapter,${JSON.stringify(f.run)});`;
    const crashed = await child(script);
    assert.equal(crashed.code, 73, crashed.stderr);
    const status = await getWorkflowStatus(f.run);
    assert.equal(status.status, 'needs_reconciliation');
    assert.equal(status.counts.needs_reconciliation, 1);
    const calls: string[] = []; const adapter = fakeAdapter(calls);
    await assert.rejects(resumeWorkflow(adapter, f.run), /reconcil|uncertain|unknown|intent/i);
    assert.equal(calls.length, 0);
    const reconciled = await reconcileWorkflow(f.run, status.items[0].itemId,
      { action: 'accept', reason: 'independent byte verifier checked isolated candidate' }, adapter);
    assert.equal(reconciled.counts.completed, 1);
    assert.equal(calls.length, 0);
  } finally { await f.cleanup(); }
});

test('independent U08: changed completed artifact cannot be silently accepted', async () => {
  const f = await fixture();
  try {
    const calls: string[] = []; const adapter = fakeAdapter(calls);
    await startWorkflow(f.config, adapter, f.run,
      { control: { async getRequest() { return calls.length === 1 ? 'pause' : undefined; } } });
    await writeFile(join(f.run, 'artifacts', '0.png'), 'externally edited artifact');
    let rejected = false;
    try { const result = await resumeWorkflow(adapter, f.run); rejected = result.status !== 'completed'; }
    catch (error) { rejected = /artifact|hash|chang|verif|reconcil/i.test(String(error)); }
    assert.equal(rejected, true); assert.equal(calls.length, 1);
  } finally { await f.cleanup(); }
});

test('independent U15: a partial trailing journal line is never reported as a clean completion', async () => {
  const f = await fixture(1);
  try {
    const calls: string[] = []; const adapter = fakeAdapter(calls);
    await startWorkflow(f.config, adapter, f.run);
    await appendFile(join(f.run, 'execution.jsonl'), '{"seq":');
    const status = await getWorkflowStatus(f.run);
    assert.equal(status.status, 'needs_reconciliation');
    await assert.rejects(resumeWorkflow(adapter, f.run), /incomplete|reconcil|journal/i);
    assert.equal(calls.length, 1);
  } finally { await f.cleanup(); }
});

test('independent U04/U14: colliding outputs and in-source run paths do not change inputs', async () => {
  const f = await fixture(1);
  try {
    const source = join(f.input, '0.aseprite'); const before = hash(await readFile(source));
    const calls: string[] = [];
    await assert.rejects(startWorkflow(f.config, fakeAdapter(calls), join(f.input, 'run')), /separate|input|overlap/i);
    assert.equal(calls.length, 0); assert.equal(hash(await readFile(source)), before);
    await writeFile(join(f.input, '0.ase'), 'different input');
    await assert.rejects(createPlan(f.config), /collision|conflict/i);
  } finally { await f.cleanup(); }
});

test('independent U09: a second process cannot resume a batch while its producer is active', async () => {
  const f = await fixture(1);
  let pending: Promise<{ code: number | null; stderr: string }> | undefined;
  try {
    const marker = join(f.root, 'producer-started');
    const moduleUrl = new URL('../../src/workflow/runtime.js', import.meta.url).href;
    const code = `import {startWorkflow} from ${JSON.stringify(moduleUrl)};
      import {readFile,writeFile} from 'node:fs/promises';
      const adapter={id:'aseprite-png',version:'aseprite-png-v1',
      probe:async source=>({status:'supported',expected:{value:await readFile(source.absolutePath,'utf8')}}),
      execute:async(source,output)=>{await writeFile(${JSON.stringify(marker)},'active');await new Promise(r=>setTimeout(r,1800));await writeFile(output,await readFile(source));return {status:'completed'};},
      verify:async(output,expected)=>({status:(await readFile(output,'utf8'))===expected.value?'verified':'failed',verifier:'bytes',expected})};
      await startWorkflow(${JSON.stringify(f.config)},adapter,${JSON.stringify(f.run)});`;
    pending = child(code);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await stat(marker); ready = true; break; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.equal(ready, true, 'First process never reached dispatch');
    const status = await getWorkflowStatus(f.run);
    assert.equal(status.status, 'running', 'Live in-flight work must not be reported as abandoned input');
    const calls: string[] = [];
    await assert.rejects(resumeWorkflow(fakeAdapter(calls), f.run), /active|lock|busy/i);
    assert.equal(calls.length, 0);
    const done = await pending;
    assert.equal(done.code, 0, done.stderr);
    assert.equal((await getWorkflowStatus(f.run)).counts.completed, 1);
  } finally { await pending; await f.cleanup(); }
});

test('independent U06b: abrupt death after commit resumes the remaining items without replaying the first', async () => {
  const f = await fixture(3);
  try {
    const moduleUrl = new URL('../../src/workflow/runtime.js', import.meta.url).href;
    const script = `import {startWorkflow} from ${JSON.stringify(moduleUrl)};
      import {readFile,writeFile} from 'node:fs/promises';
      const adapter={id:'aseprite-png',version:'aseprite-png-v1',
      probe:async source=>({status:'supported',expected:{value:await readFile(source.absolutePath,'utf8')}}),
      execute:async(source,output)=>{await writeFile(output,await readFile(source));return {status:'completed'};},
      verify:async(output,expected)=>({status:(await readFile(output,'utf8'))===expected.value?'verified':'failed',verifier:'bytes',expected})};
      await startWorkflow(${JSON.stringify(f.config)},adapter,${JSON.stringify(f.run)},
        {onProgress:report=>{if(report.counts.completed===1)process.exit(74);}});`;
    const crashed = await child(script);
    assert.equal(crashed.code, 74, crashed.stderr);
    const completed = join(f.run, 'artifacts', '0.png');
    const firstTime = (await stat(completed)).mtimeMs;
    const calls: string[] = [];
    const resumed = await resumeWorkflow(fakeAdapter(calls), f.run);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.counts.completed, 3);
    assert.equal(calls.length, 2);
    assert.equal(calls.includes(join(f.input, '0.aseprite')), false);
    assert.equal((await stat(completed)).mtimeMs, firstTime);
  } finally { await f.cleanup(); }
});
