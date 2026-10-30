import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inspectCore, preparePackages, verifiedExtract, validateVersions } from '../../scripts/prepare-npm.mjs';
import { manifest } from '../../lib/native.mjs';

async function fixture(root) {
  for (const name of ['bin/computer-pilot.exe', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/MCP.md',
    'profiles/mspaint-classic-zh-CN/profile.json', 'skills/computerpilot/SKILL.md']) {
    await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(join(root, name), 'fixture');
  }
  await writeFile(join(root, 'core-manifest.json'), JSON.stringify({ name: 'ComputerPilot', version: manifest.version }));
}

test('package assembly preserves resources, pins versions and excludes development scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computerpilot-package-'));
  try {
    await fixture(join(root, 'core')); const output = join(root, 'packages');
    assert.equal(validateVersions(), manifest.version);
    const result = await preparePackages({ core: join(root, 'core'), platform: 'win32-x64', output });
    assert.deepEqual(result.packages, ['computerpilot-win32-x64', 'computerpilot']);
    const wrapper = JSON.parse(await readFile(join(output, 'computerpilot/package.json')));
    assert.equal(wrapper.scripts, undefined); assert.equal(wrapper.optionalDependencies['computerpilot-win32-x64'], manifest.version);
    assert.equal(wrapper.private, undefined);
    const native = JSON.parse(await readFile(join(output, 'computerpilot-win32-x64/package.json')));
    assert.deepEqual(native.os, ['win32']); assert.deepEqual(native.cpu, ['x64']);
    assert.equal(await readFile(join(output, 'computerpilot-win32-x64/profiles/mspaint-classic-zh-CN/profile.json'), 'utf8'), 'fixture');
    assert.match(await readFile(join(output, 'computerpilot/skills/computerpilot/SKILL.md'), 'utf8'), /name: computerpilot/);
    await assert.rejects(preparePackages({ core: join(root, 'core'), platform: 'win32-x64', output }), /never overwritten/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local recordings, models, configuration and symlinks cannot enter native npm packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computerpilot-package-reject-'));
  try {
    await fixture(root);
    for (const name of ['sample.onnx', 'calls.jsonl', 'installation.json', '.env']) {
      const file = join(root, name); await writeFile(file, 'local fixture');
      await assert.rejects(inspectCore(root, 'win32-x64'), /not allowed/); await rm(file);
    }
    await writeFile(join(root, 'core-manifest.json'), '{"name":"ComputerPilot","version":"0.0.0"}');
    await assert.rejects(inspectCore(root, 'win32-x64'), /Core version must match/);
    await writeFile(join(root, 'core-manifest.json'), JSON.stringify({ name: 'ComputerPilot', version: manifest.version }));
    await symlink(join(root, 'docs'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectCore(root, 'win32-x64'), /Links are not allowed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release archives require an exact checksum and preserve the published root layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computerpilot-archive-'));
  try {
    await fixture(join(root, 'ComputerPilot'));
    const archive = join(root, 'core.tar.gz');
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    execFileSync(tar, ['-czf', archive, '-C', root, 'ComputerPilot']);
    await assert.rejects(verifiedExtract(archive, `${'0'.repeat(64)}  core.tar.gz`, join(root, 'bad')), /checksum mismatch/);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    await assert.rejects(verifiedExtract(archive, `${digest}  core.tar.gz\n${digest}  core.tar.gz`, join(root, 'duplicate')), /checksum mismatch/);
    const extracted = await verifiedExtract(archive, `${digest}  core.tar.gz`, join(root, 'verified'));
    await inspectCore(extracted, 'win32-x64');
    await writeFile(join(root, 'unrelated.txt'), 'fixture'); execFileSync(tar, ['-czf', archive, '-C', root, 'unrelated.txt']);
    const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
    await assert.rejects(verifiedExtract(archive, `${hash}  core.tar.gz`, join(root, 'unsafe')), /Unsafe archive path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
