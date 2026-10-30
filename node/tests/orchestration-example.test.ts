import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopOrchestrationHost } from '../src/orchestration/desktop-host.js';
import { resumeOrchestration, startOrchestration } from '../src/orchestration/runner.js';
import type { ReplayApi } from '../src/replay/runner.js';

const example = fileURLToPath(new URL('../../../examples/orchestration/copy-field/', import.meta.url));
const script = join(example, 'workflow.mjs');
const sourceControl = { name:'Message', role:'Edit', value:'Hello', enabled:true, offscreen:false };
const complete = { status:'ok', evidenceComplete:true, stopReason:'complete' };

for (const [name, controls, inspection] of [
  ['missing field', [], complete],
  ['duplicate fields', [sourceControl, sourceControl], complete],
  ['non-string value', [{...sourceControl, value:17}], complete],
  ['missing value', [{name:'Message', role:'Edit', enabled:true, offscreen:false}], complete],
  ['disabled field', [{...sourceControl, enabled:false}], complete],
  ['offscreen field', [{...sourceControl, offscreen:true}], complete],
  ['unknown visibility', [{name:'Message', role:'Edit', value:'Hello', enabled:true}], complete],
  ['wrong role', [{...sourceControl, role:'Text'}], complete],
  ['incomplete inspection', [sourceControl], {...complete, status:'incomplete'}],
  ['missing inspection', [sourceControl], null],
  ['incomplete evidence', [sourceControl], {...complete, evidenceComplete:false}],
  ['truncated inspection', [sourceControl], {...complete, truncated:true}],
  ['paged inspection', [sourceControl], {...complete, has_more:true}],
  ['depth limit', [sourceControl], {...complete, stopReason:'depth_limit'}],
  ['provider error', [sourceControl], {...complete, providerError:'failed'}]
] as const) {
  test(`copy-field example refuses ${name} without touching the target`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dp-copy-source-'));
    let writes = 0, targetReads = 0;
    const api: ReplayApi = { async call(tool, args) {
      if (tool === 'list_windows') return {status:'ok', windows:[
        {window_id:'source', title:'Source App'}, {window_id:'target', title:'Target App'}]};
      if (tool === 'get_window_state') {
        if (args.window_id === 'target') targetReads++;
        return {status:'ok', title:'Source App', controls, inspection};
      }
      if (tool === 'execute_batch') { writes++; return {status:'ok', completed:1}; }
      throw new Error(`Unexpected ${tool}`);
    } };
    const host = createDesktopOrchestrationHost(api, root, root, async () => async () => {});
    try {
      const definition = JSON.parse(await readFile(join(example, 'definition.json'), 'utf8'));
      const report = await startOrchestration(definition.name, script, definition.input, join(root, 'run'), host);
      assert.equal(report.status, 'failed', report.message ?? '');
      assert.match(report.message ?? '', /Source/);
      assert.equal(writes, 0); assert.equal(targetReads, 0);
    } finally { await host.releaseDesktop?.(); await rm(root, {recursive:true, force:true}); }
  });
}

test('copy-field example recovers a target precondition without rereading or rewriting committed work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dp-copy-recovery-'));
  let value = 'existing', writes = 0, sourceReads = 0;
  const api: ReplayApi = { async call(tool, args) {
    if (tool === 'list_windows') return {status:'ok', windows:[
      {window_id:'source', title:'Source App'}, {window_id:'target', title:'Target App'}]};
    if (tool === 'get_window_state') {
      const source = args.window_id === 'source';
      if (source) sourceReads++;
      return {status:'ok', title:source ? 'Source App' : 'Target App', inspection:complete,
        controls:[{...sourceControl, control_id:'current', value:source ? 'Hello' : value}]};
    }
    if (tool === 'execute_batch') {
      writes++; assert.equal(args.window_id, 'target');
      assert.deepEqual(args.actions, [{type:'fill_text', control_id:'current', text:'Hello'}]);
      value = 'Hello'; return {status:'ok', completed:1};
    }
    throw new Error(`Unexpected ${tool}`);
  } };
  const run = join(root, 'run');
  const host = createDesktopOrchestrationHost(api, run, run, async () => async () => {});
  try {
    const definition = JSON.parse(await readFile(join(example, 'definition.json'), 'utf8'));
    const first = await startOrchestration(definition.name, script, definition.input, run, host);
    assert.equal(first.status, 'retry_available', first.message ?? '');
    assert.equal(first.pending?.dispatch, 'not_dispatched');
    assert.equal(writes, 0); assert.equal(sourceReads, 1);
    value = '';
    const resumed = await resumeOrchestration(run, host);
    assert.equal(resumed.status, 'completed', resumed.message ?? '');
    assert.equal(value, 'Hello'); assert.equal(writes, 1); assert.equal(sourceReads, 1);
    assert.equal((await resumeOrchestration(run, host)).status, 'completed');
    assert.equal(writes, 1); assert.equal(sourceReads, 1);
  } finally { await host.releaseDesktop?.(); await rm(root, {recursive:true, force:true}); }
});
