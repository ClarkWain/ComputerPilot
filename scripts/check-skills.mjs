import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { packageRoot } from '../lib/native.mjs';

const minimum = process.versions.node.split('.').map(Number);
if (minimum[0] < 22 || (minimum[0] === 22 && minimum[1] < 20))
  throw new Error('Skills CLI 1.7.4 requires Node >=22.20. Use a recent Node.js LTS for this check.');
if (!process.env.npm_execpath) throw new Error('Run npm run test:skills');
const root = await mkdtemp(join(tmpdir(), 'computerpilot-skill-install-'));
try {
  const args = [process.env.npm_execpath, 'exec', '--yes', '--package=skills@1.7.4', '--', 'skills',
    'add', packageRoot, '--skill', 'computerpilot', '--agent', 'codex', '--yes', '--copy'];
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' } });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (exit !== 0) throw new Error(`Skills CLI failed: ${exit}`);
  const installed = join(root, '.agents/skills/computerpilot');
  if (!/name: computerpilot/.test(await readFile(join(installed, 'SKILL.md'), 'utf8')))
    throw new Error('Installed skill is missing its discovery metadata');
  if (!(await readFile(join(installed, 'SKILL.md'), 'utf8')).includes('computer-pilot mcp-config'))
    throw new Error('Skills CLI selected an outdated skill copy');
  await readFile(join(installed, 'references/protocol.md'));
  await readFile(join(installed, 'scripts/install.ps1'));
  console.log('Skills CLI discovered and installed computerpilot with its references into an isolated project.');
} finally { await rm(root, { recursive: true, force: true }); }
