#!/usr/bin/env node
import { manifest, resolveNative, mcpConfig, runNative } from '../lib/native.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(manifest.version);
  } else {
    const info = resolveNative();
    if (args.length === 1 && args[0] === 'info') console.log(JSON.stringify(info, null, 2));
    else if (args[0] === 'mcp-config') {
      if (args.length !== 1 && !(args.length === 3 && args[1] === '--format'))
        throw new Error('Usage: computer-pilot mcp-config [--format json|toml]');
      const format = args[2] ?? 'json', config = mcpConfig(info, format);
      console.log(typeof config === 'string' ? config.trimEnd() : JSON.stringify(config, null, 2));
    }
    else if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      process.exitCode = await runNative(info, ['--help']);
      if (!process.exitCode) console.log('\nnpm helpers:\n  --version     Show the package version\n  info          Show native executable and resource paths as JSON\n  mcp-config    Print MCP client JSON (--format toml for Codex)');
    }
    else process.exitCode = await runNative(info, args);
  }
} catch (error) {
  console.error(`computer-pilot: ${error.message}`);
  process.exitCode = 1;
}
