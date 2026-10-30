import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manifest, platforms } from '../../lib/native.mjs';

const publisher = fileURLToPath(new URL('../../scripts/publish-npm.mjs', import.meta.url));
test('publisher defaults to dry run, publishes the entry last and rejects conflicting immutable versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computerpilot-publish-'));
  try {
    const names = [...Object.values(platforms).map(p => p.name), manifest.name];
    for (const name of names) {
      await mkdir(join(root, name)); await writeFile(join(root, name, 'package.json'), JSON.stringify({ name, version: manifest.version }));
    }
    await writeFile(join(root, 'packages.json'), JSON.stringify({ version: manifest.version, packages: names }));
    const mock = join(root, 'npm.mjs'), log = join(root, 'calls.json');
    await writeFile(mock, `import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),file=process.env.CP_TEST_LOG;
const calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];calls.push(args);fs.writeFileSync(file,JSON.stringify(calls));
if(args[0]==='pack'){const p=JSON.parse(fs.readFileSync(path.join(args[1],'package.json')));console.log(JSON.stringify([{filename:p.name+'.tgz',integrity:'sha512-fixture'}]));}
else if(args[0]==='view'){if(process.env.CP_TEST_EXISTS==='yes')console.log(JSON.stringify(process.env.CP_TEST_CONFLICT?'sha512-other':'sha512-fixture'));else{console.error('E404');process.exitCode=1;}}
else if(args[0]!=='publish')throw new Error('Unexpected npm operation');`);
    const run = flags => spawnSync(process.execPath, [publisher, '--packages', root, ...flags],
      { encoding: 'utf8', env: { ...process.env, npm_execpath: mock, CP_TEST_LOG: log }, windowsHide: true });
    let result = run([]); assert.equal(result.status, 0, result.stderr);
    let calls = JSON.parse(await readFile(log));
    const publications = calls.filter(a => a[0] === 'publish');
    assert.equal(publications.length, 3); assert.ok(publications.every(a => a.includes('--dry-run')));
    assert.ok(publications.at(-1)[1].endsWith('computerpilot.tgz'));
    assert.equal(calls.filter(a => a[0] === 'view').length, 0);
    await writeFile(log, '[]');
    result = run(['--publish']); assert.equal(result.status, 0, result.stderr);
    calls = JSON.parse(await readFile(log)); assert.equal(calls.filter(a => a[0] === 'publish').length, 3);
    assert.ok(!calls.filter(a => a[0] === 'publish').some(a => a.includes('--dry-run')));
    await writeFile(log, '[]');
    result = spawnSync(process.execPath, [publisher, '--packages', root, '--publish'], { encoding: 'utf8',
      env: { ...process.env, npm_execpath: mock, CP_TEST_LOG: log, CP_TEST_EXISTS: 'yes', CP_TEST_CONFLICT: 'yes' }, windowsHide: true });
    assert.equal(result.status, 1); assert.match(result.stderr, /different contents/);
    assert.equal(JSON.parse(await readFile(log)).filter(a => a[0] === 'publish').length, 0);
    await writeFile(log, '[]');
    result = spawnSync(process.execPath, [publisher, '--packages', root, '--publish'], { encoding: 'utf8',
      env: { ...process.env, npm_execpath: mock, CP_TEST_LOG: log, CP_TEST_EXISTS: 'yes' }, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(log)).filter(a => a[0] === 'publish').length, 0);
    result = run(['--publish=false']); assert.equal(result.status, 1); assert.match(result.stderr, /Unknown publishing option/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
