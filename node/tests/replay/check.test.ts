import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkRecipe } from '../../src/replay/check.js';
import { exportArchive } from '../../src/replay/archive.js';
import type { ReplayRecipe } from '../../src/replay/recipe.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cli = fileURLToPath(new URL('../../src/replay/cli.js', import.meta.url));
const discovery = { match: { executable: 'paint.exe', className: 'Paint', requiredSelectors: [] }, selectors: {} };
const recipe: ReplayRecipe = { schemaVersion: 1, name: 'offline', target: { titleContains: 'Paint' },
  steps: [{ id: 'first', profile: 'mspaint-classic-zh-CN',
    action: { action: 'drawing.drawEllipse', args: {} }, expect: { titleContains: 'Paint' } }] };
const run = (command: string, input: string, profiles = join(root, 'profiles')) => spawnSync(process.execPath,
  [cli, command, input], { encoding: 'utf8', env: { ...process.env,
    DP_PROFILES_DIR: profiles, DP_NATIVE_EXE: 'missing-offline-worker.exe' } });
async function saveRecipe(directory: string, value = recipe) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: value.schemaVersion,
    name: value.name, target: value.target }));
  await writeFile(join(directory, 'steps.json'), JSON.stringify(value.steps));
}

test('offline check loads shipped profiles and known Node actions without a worker', async () => {
  for (const id of ['mspaint-classic-zh-CN', 'mspaint-modern-zh-CN', 'aseprite-vision-en']) {
    const profile = JSON.parse(await readFile(join(root, 'profiles', id, 'profile.json'), 'utf8'));
    const result = await checkRecipe({ ...recipe, steps: [{ ...recipe.steps[0], profile: id,
      action: undefined, actions: profile.actions.map((item: any) => ({ action: item.action, args: {} })) }] },
    join(root, 'profiles'));
    assert.equal(result.compatible, true, JSON.stringify(result.issues));
    assert.equal(result.environmentChecked, false);
    assert.equal(result.parametersChecked, false);
  }
});

test('check reports all missing profiles, unsupported adapters and action problems', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dp-check-profiles-'));
  try {
    for (const [id, adapter] of [['custom', 'future-adapter'], ['modern', 'paint-modern']]) {
      await mkdir(join(base, id));
      await writeFile(join(base, id, 'profile.json'), JSON.stringify({ ...discovery, id, schemaVersion: 1, adapter,
        actions: [{ action: 'drawing.drawEllipse' }] }));
    }
    const result = await checkRecipe({ ...recipe, steps: [
      { ...recipe.steps[0], id: 'missing', profile: 'absent' },
      { ...recipe.steps[0], id: 'custom', profile: 'custom', action: undefined,
        actions: [{ action: 'drawing.drawEllipse', args: {} }, { action: 'typo', args: {} }] },
      { ...recipe.steps[0], id: 'modern', profile: 'modern' }
    ] }, base);
    assert.equal(result.formatValid, true);
    assert.equal(result.knownProfiles, false);
    assert.equal(result.knownActions, false);
    assert.equal(result.compatible, false);
    assert.deepEqual(result.issues.map(issue => issue.code), ['unknown_profile', 'unsupported_adapter',
      'unsupported_action', 'unknown_action', 'unsupported_action']);
    assert.equal(result.issues[3].actionIndex, 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('CLI check supports custom profiles and archives without a native executable; validate stays format-only', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dp-check-cli-'));
  try {
    const directory = join(base, 'recipe'), profiles = join(base, 'profiles');
    await mkdir(join(profiles, 'local'), { recursive: true });
    await writeFile(join(profiles, 'local', 'profile.json'), JSON.stringify({ ...discovery, id: 'local', schemaVersion: 1,
      adapter: 'paint-modern', actions: [{ action: 'drawing.setColor' }] }));
    await saveRecipe(directory, { ...recipe, steps: [{ ...recipe.steps[0], profile: 'local',
      action: { action: 'drawing.setColor', args: { color: [1, 2, 3] } } }] });
    for (const input of [directory, join(base, 'recipe.dpreplay')]) {
      if (input.endsWith('.dpreplay')) await exportArchive(directory, input);
      const result = run('check', input, profiles);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).compatible, true);
      assert.equal(JSON.parse(result.stdout).environmentChecked, false);
      assert.equal(JSON.parse(result.stdout).profilesDirectory, profiles);
    }
    const incompatible = run('check', directory);
    assert.equal(incompatible.status, 1);
    assert.equal(JSON.parse(incompatible.stdout).issues[0].code, 'unknown_profile');
    const validated = run('validate', directory);
    assert.equal(validated.status, 0, validated.stderr);
    assert.match(validated.stdout, /Valid recipe/);
    await writeFile(join(directory, 'steps.json'), JSON.stringify([{ ...recipe.steps[0], surprise: true }]));
    const bad = run('check', directory, profiles);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown field: surprise/);
    assert.equal(bad.stdout, '');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('CLI check locates default profiles independently of working directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dp-check-default-'));
  try {
    await saveRecipe(base);
    const env: NodeJS.ProcessEnv = { ...process.env, DP_NATIVE_EXE: 'missing-offline-worker.exe' };
    delete env.DP_PROFILES_DIR;
    delete env.DESKTOPPILOT_PROFILES_DIR;
    const result = spawnSync(process.execPath, [cli, 'check', base], { cwd: tmpdir(), encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).knownProfiles, true);
    assert.equal(JSON.parse(result.stdout).knownActions, true);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('offline check rejects malformed discovery manifests and continues collecting issues without a worker', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dp-check-malformed-'));
  try {
    const directory = join(base, 'recipe'), profiles = join(base, 'profiles');
    const malformed = [
      { match: undefined },
      { match: { ...discovery.match, executable: 42 } },
      { match: { ...discovery.match, className: '' } },
      { match: { ...discovery.match, requiredSelectors: 'canvas' } },
      { match: { ...discovery.match, requiredSelectors: ['canvas'] } },
      { selectors: null },
      { match: { ...discovery.match, requiredSelectors: ['canvas'] }, selectors: { canvas: null } },
      { match: { ...discovery.match, requiredSelectors: ['canvas'] }, selectors: { canvas: {} } },
      { actions: [null] }
    ];
    const steps = [];
    for (const [index, fields] of malformed.entries()) {
      const id = `broken-${index}`;
      await mkdir(join(profiles, id), { recursive: true });
      await writeFile(join(profiles, id, 'profile.json'), JSON.stringify({ ...discovery, id,
        schemaVersion: 1, actions: [{ action: 'drawing.drawEllipse' }], ...fields }));
      steps.push({ ...recipe.steps[0], id, profile: id });
    }
    steps.push({ ...recipe.steps[0], id: 'absent', profile: 'absent' });
    await saveRecipe(directory, { ...recipe, steps });
    const result = run('check', directory, profiles);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.compatible, false);
    assert.equal(report.knownProfiles, false);
    assert.equal(report.environmentChecked, false);
    assert.deepEqual(report.issues.map((issue: any) => issue.code),
      [...malformed.map(() => 'invalid_profile'), 'unknown_profile']);
  } finally { await rm(base, { recursive: true, force: true }); }
});
