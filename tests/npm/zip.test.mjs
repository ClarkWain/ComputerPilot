import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { verifiedExtract } from '../../scripts/prepare-npm.mjs';

test('Windows release ZIPs use the checksum-verified archive reader on each platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computerpilot-zip-'));
  try {
    await mkdir(join(root, 'ComputerPilot')); await writeFile(join(root, 'ComputerPilot/fixture.txt'), 'fixture');
    const archive = join(root, 'core.zip'), python = process.platform === 'win32' ? 'python' : 'python3';
    execFileSync(python, ['-c', 'import pathlib,sys,zipfile;root=pathlib.Path(sys.argv[1]);z=zipfile.ZipFile(sys.argv[2],"w");z.write(root/"ComputerPilot/fixture.txt","ComputerPilot/fixture.txt");z.close()', root, archive]);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    if (process.platform === 'linux' && !existsSync('/usr/bin/bsdtar')) {
      await assert.rejects(verifiedExtract(archive, `${digest}  core.zip`, join(root, 'verified')), /libarchive-tools/); return;
    }
    const directory = await verifiedExtract(archive, `${digest}  core.zip`, join(root, 'verified'));
    assert.equal(await readFile(join(directory, 'fixture.txt'), 'utf8'), 'fixture');
  } finally { await rm(root, { recursive: true, force: true }); }
});
