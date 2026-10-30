import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { resolveNative, manifest, mcpConfig, runNative } from '../../lib/native.mjs';

test('each supported platform resolves the matching versioned native package', () => {
  for (const [platform, arch, name, binary] of [
    ['win32', 'x64', 'computerpilot-win32-x64', 'computer-pilot.exe'],
    ['darwin', 'arm64', 'computerpilot-darwin-arm64', 'computer-pilot']]) {
    const path = join(process.cwd(), 'test packages', name, 'package.json');
    const result = resolveNative({ platform, arch,
      resolvePackage: id => { assert.equal(id, `${name}/package.json`); return path; },
      read: () => JSON.stringify({ name, version: manifest.version }), exists: () => true });
    assert.equal(result.executable, join(dirname(path), 'bin', binary));
    const toml = mcpConfig(result, 'toml');
    assert.match(toml, /^\[mcp_servers.computer-pilot\]/);
    assert.ok(toml.includes(`command = ${JSON.stringify(result.executable)}`));
    assert.throws(() => mcpConfig(result, 'yaml'), /Unknown MCP configuration format/);
    assert.deepEqual(mcpConfig(result), { mcpServers: { 'computer-pilot': { command: result.executable, args: ['serve'] } } });
  }
});

test('unsupported combinations and missing, incomplete or mismatched packages fail with a recovery instruction', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'x64'], ['win32', 'arm64']])
    assert.throws(() => resolveNative({ platform, arch }), /does not provide/);
  const base = { platform: 'win32', arch: 'x64' };
  assert.throws(() => resolveNative({ ...base, resolvePackage() { throw new Error('missing'); } }), /optional dependencies enabled/);
  assert.throws(() => resolveNative({ ...base, resolvePackage: () => 'package.json', read: () => '{"name":"other","version":"0.0.0"}' }), /version mismatch/);
  assert.throws(() => resolveNative({ ...base, resolvePackage: () => 'package.json',
    read: () => JSON.stringify({ name: 'computerpilot-win32-x64', version: manifest.version }), exists: () => false }), /executable is missing/);
});

test('native launch preserves argument boundaries, inherits MCP streams and forwards interruption without retry', async () => {
  const signals = new EventEmitter(), child = new EventEmitter(); child.exitCode = null;
  const killed = []; child.kill = signal => killed.push(signal);
  const args = ['serve', '--record', 'directory with spaces']; let launches = 0;
  const result = runNative({ executable: 'native binary' }, args, { signals, spawnProcess(executable, actual, options) {
    launches++; assert.equal(executable, 'native binary'); assert.deepEqual(actual, args);
    assert.deepEqual(options, { stdio: 'inherit', windowsHide: true }); return child;
  } });
  signals.emit('SIGTERM'); child.emit('exit', null, 'SIGTERM');
  assert.equal(await result, 143); assert.deepEqual(killed, ['SIGTERM']); assert.equal(launches, 1);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('native failure propagates its exit code and spawn errors clean up handlers', async () => {
  const signals = new EventEmitter(), child = new EventEmitter(); child.exitCode = null;
  const result = runNative({ executable: 'native' }, [], { signals, spawnProcess: () => child });
  child.emit('exit', 42, null); assert.equal(await result, 42);
  const failed = new EventEmitter(); failed.exitCode = null;
  const pending = runNative({ executable: 'missing' }, [], { signals, spawnProcess: () => failed });
  failed.emit('error', new Error('ENOENT')); await assert.rejects(pending, /Could not start/);
  for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) assert.equal(signals.listenerCount(event), 0);
});
