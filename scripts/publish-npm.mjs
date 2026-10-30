import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { manifest, platforms } from '../lib/native.mjs';

try {
  const args = process.argv.slice(2), at = args.indexOf('--packages');
  if (at < 0 || !args[at + 1] || !process.env.npm_execpath) throw new Error('Run npm run publish:npm -- --packages DIR [--publish] [--provenance]');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--packages') { i++; continue; }
    if (!['--publish', '--provenance'].includes(args[i])) throw new Error(`Unknown publishing option: ${args[i]}`);
  }
  const directory = resolve(args[at + 1]), live = args.includes('--publish');
  const run = (a, options = {}) => {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...a], { encoding: 'utf8', windowsHide: true, ...options });
    if (result.error) throw result.error;
    return result;
  };
  const listing = JSON.parse(await readFile(join(directory, 'packages.json'), 'utf8'));
  const names = [...Object.values(platforms).map(p => p.name), manifest.name];
  if (listing.version !== manifest.version || JSON.stringify(listing.packages) !== JSON.stringify(names))
    throw new Error('Publishing requires both native packages followed by the matching entry package');
  const tarballs = join(directory, 'tarballs'); await mkdir(tarballs, { recursive: true });
  const prepared = [];
  for (const name of names) {
    const path = join(directory, name), pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    if (pkg.name !== name || pkg.version !== manifest.version) throw new Error(`Package identity/version mismatch: ${name}`);
    const result = run(['pack', path, '--json', '--ignore-scripts', '--pack-destination', tarballs]);
    if (result.status !== 0) throw new Error(result.stderr || 'npm pack failed');
    prepared.push({ name, ...JSON.parse(result.stdout)[0] });
  }
  for (const pkg of prepared) {
    const file = join(tarballs, pkg.filename);
    if (live) {
      const previous = run(['view', `${pkg.name}@${manifest.version}`, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org']);
      if (previous.status === 0) {
        if (JSON.parse(previous.stdout) !== pkg.integrity) throw new Error(`${pkg.name}@${manifest.version} already exists with different contents; use a new version`);
        console.log(`Already published with matching integrity: ${pkg.name}`); continue;
      }
      if (!/E404/.test(previous.stderr + previous.stdout)) throw new Error(previous.stderr || 'Could not check published package');
    }
    const result = run(['publish', file, '--access=public', '--ignore-scripts', '--registry=https://registry.npmjs.org',
      ...(!live ? ['--dry-run'] : []), ...(live && args.includes('--provenance') ? ['--provenance'] : [])]);
    if (result.status !== 0) throw new Error(result.stderr || 'npm publish failed');
    console.log(`${live ? 'Published' : 'Dry run passed'}: ${pkg.name}@${manifest.version}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
