import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
export const platforms = Object.freeze({
  'win32-x64': { name: 'computerpilot-win32-x64', binary: 'computer-pilot.exe', asset: 'ComputerPilot-windows-x64-core.zip' },
  'darwin-arm64': { name: 'computerpilot-darwin-arm64', binary: 'computer-pilot', asset: 'ComputerPilot-macos-arm64-core.tar.gz' }
});

export function resolveNative({ platform = process.platform, arch = process.arch,
  resolvePackage = name => require.resolve(name), read = readFileSync, exists = existsSync } = {}) {
  const key = `${platform}-${arch}`, target = platforms[key];
  if (!target) throw new Error(`ComputerPilot does not provide a native package for ${platform}/${arch}. Supported: Windows x64 and macOS arm64 (14+).`);
  let path;
  try { path = resolvePackage(`${target.name}/package.json`); }
  catch { throw new Error(`Missing ${target.name}@${manifest.version}. Reinstall computerpilot with optional dependencies enabled (omit --omit=optional / --no-optional).`); }
  const installed = JSON.parse(read(path, 'utf8'));
  if (installed.name !== target.name || installed.version !== manifest.version)
    throw new Error(`Native package version mismatch: expected ${target.name}@${manifest.version}; reinstall computerpilot.`);
  const root = dirname(path), executable = join(root, 'bin', target.binary);
  if (!exists(executable)) throw new Error(`Native executable is missing: ${executable}. Reinstall computerpilot.`);
  return { version: manifest.version, platform, arch, root, executable,
    skill: join(packageRoot, 'skills', 'computerpilot') };
}

export function mcpConfig(info, format = 'json') {
  if (format === 'toml') return `[mcp_servers.computer-pilot]\ncommand = ${JSON.stringify(info.executable)}\nargs = ["serve"]\n`;
  if (format !== 'json') throw new Error(`Unknown MCP configuration format: ${format}`);
  return { mcpServers: { 'computer-pilot': { command: info.executable, args: ['serve'] } } };
}

// Keep the native MCP stream untouched; the wrapper never retries dispatched input.
export function runNative(info, args, { spawnProcess = spawn, signals = process } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(info.executable, args, { stdio: 'inherit', windowsHide: true });
    const handlers = new Map();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => { if (child.exitCode === null) child.kill(signal); };
      handlers.set(signal, handler); signals.on(signal, handler);
    }
    const cleanup = () => { for (const [signal, handler] of handlers) signals.removeListener(signal, handler); };
    child.once('error', error => { cleanup(); reject(new Error(`Could not start ComputerPilot: ${error.message}`, { cause: error })); });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1));
    });
  });
}
