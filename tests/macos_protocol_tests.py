"""Headless MCP/file transport regression; never sends desktop input."""
import json
import pathlib
import subprocess
import sys
import tempfile

exe, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
schema = json.loads(subprocess.check_output([exe, 'agent-schema']))
assert {t['name'] for t in schema} == {'list_windows', 'get_window_state', 'execute_semantic', 'execute_batch'}
assert schema == json.loads((root / 'docs/agent-tools.schema.json').read_text())
messages = [
    {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'macos-test', 'version': '1'}}},
    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
    {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'get_window_state', 'arguments': {'window_id': 'unobserved'}}},
    {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'legacy.click', 'arguments': {}}},
    {'jsonrpc': '2.0', 'id': 5, 'method': 'ping'},
]
wire = ''.join(json.dumps(m) + '\n' for m in messages)
run = subprocess.run([exe, 'serve'], input=wire, capture_output=True, text=True, timeout=30)
assert run.returncode == 0, run.stderr
responses = {m['id']: m for m in map(json.loads, run.stdout.splitlines())}
assert len(responses) == 5, responses
preflight = responses[1]['result']['_meta']['desktopPilot/desktopPreflight']
assert isinstance(preflight['ready'], bool)
assert preflight['session']['platform'] == 'macos'
assert preflight['executionMode'] in ('interactive', 'background_only')
assert preflight['capabilities']['lockedApplicationActions'] == []
assert 'vision.parse' in preflight['capabilities']['backgroundOperations']
assert 'ui.fill' not in preflight['capabilities']['backgroundOperations']
assert isinstance(preflight['session']['desktopGeneration'], int)
assert responses[2]['result']['tools'] == schema
assert responses[3]['result']['isError']
assert responses[4]['error']['code'] == -32602
assert responses[5]['result'] == {}
with tempfile.TemporaryDirectory(prefix='dp-mac-中文-') as folder:
    folder = pathlib.Path(folder)
    source, output = folder / '请求.jsonl', folder / '响应.jsonl'
    source.write_text(wire)
    run = subprocess.run([exe, 'serve', '--input', source, '--output', output], capture_output=True, timeout=30)
    assert run.returncode == 0, run.stderr
    assert len(output.read_text().splitlines()) == 5
    original = source.read_bytes()
    bad = subprocess.run([exe, 'serve', '--input', source, '--output', source], capture_output=True)
    assert bad.returncode != 0 and source.read_bytes() == original
    recording = folder / '录制'
    run = subprocess.run([exe, 'serve', '--record', recording], input=wire, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr
    entries = [json.loads(line) for line in (recording / 'session.jsonl').read_text().splitlines()]
    assert entries[0] == {'event': 'session', 'schemaVersion': 1, 'source': 'desktop-pilot-calls'}
    assert entries[-1] == {'event': 'end', 'calls': 1}
    assert entries[1]['tool'] == 'get_window_state' and entries[2]['result']['status'] == 'error'
    recorded = (recording / 'session.jsonl').read_bytes()
    refusal = subprocess.run([exe, 'serve', '--record', recording], input=wire, capture_output=True, text=True, timeout=30)
    assert refusal.returncode != 0 and (recording / 'session.jsonl').read_bytes() == recorded
    template = root / 'examples/replays/flower-preview/replay.json'
    for destination, journal in [(folder / 'same', folder / 'same'), (folder / 'outer', folder / 'outer/inner'), (folder / 'another/inner', folder / 'another')]:
        refusal = subprocess.run([exe, 'replay', '--file', template, '--mode', 'run', '--output', destination, '--record', journal], capture_output=True, timeout=30)
        assert refusal.returncode != 0 and not destination.exists() and not journal.exists()
print('PASS macOS MCP schema, preflight, errors, ping, Unicode file transport')

# Exercise the real native gate without sending input, including a capture race's
# structured error path through Service (it must not index a missing imageRef).
if not preflight['ready']:
    requests = [
        {'id': 10, 'operation': 'runtime.capabilities', 'args': {}},
        {'id': 11, 'operation': 'input.key_chord', 'args': {'keys': ['ENTER']}},
        {'id': 12, 'operation': 'capture.window', 'args': {}},
    ]
    raw = subprocess.run([exe, 'jsonl'], input=''.join(json.dumps(r) + '\n' for r in requests), capture_output=True, text=True, timeout=30)
    assert raw.returncode == 0, raw.stderr
    replies = {r['id']: r for r in map(json.loads, raw.stdout.splitlines())}
    assert replies[10]['result']['desktopPreflight']['capabilities']['lockedApplicationActions'] == []
    for request_id in (11, 12):
        denial = replies[request_id]['result']
        assert denial['paused'] and denial['resumeRequiresObservation']
        assert denial['dispatch'] == 'not_started'
        assert denial['code'] in ('desktop_locked', 'desktop_environment_not_ready')
    print('PASS native blocked-session gates and background diagnostics')
