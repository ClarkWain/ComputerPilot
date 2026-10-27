#!/usr/bin/env python3
"""Read-only MCP onboarding: show the actual worker preflight and window list."""
import json
import pathlib
import subprocess
import sys

exe = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'build/core/desktop-pilot').resolve()
messages = [
    {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'macos-onboarding', 'version': '1'}}},
    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'list_windows', 'arguments': {}}},
]
run = subprocess.run([exe, 'serve'], input=''.join(json.dumps(m) + '\n' for m in messages), capture_output=True, text=True, timeout=30)
if run.returncode:
    raise SystemExit(run.stderr or run.stdout)
responses = {m['id']: m for m in map(json.loads, run.stdout.splitlines())}
preflight = responses[1]['result']['_meta']['desktopPilot/desktopPreflight']
result = responses[2].get('result', {})
print(json.dumps({'preflight': preflight, 'resume': 'After unlock, observe again and submit only unfinished actions; no automatic replay.' if preflight.get('ready') is not True else None, 'windows': result.get('structuredContent', result)}, ensure_ascii=False, indent=2))
raise SystemExit(0 if preflight.get('ready') is True else 3)
