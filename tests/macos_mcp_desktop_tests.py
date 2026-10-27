"""Real four-tool acceptance against a disposable Cocoa fixture only."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

exe, fixture = map(lambda p: Path(p).resolve(), sys.argv[1:3])
artifacts = Path(sys.argv[3]).resolve()
artifacts.mkdir(parents=True, exist_ok=True)
log = (artifacts / 'mcp-stderr.txt').open('w')
server = subprocess.Popen([exe, 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
selector = selectors.DefaultSelector()
selector.register(server.stdout, selectors.EVENT_READ)
pending = bytearray()
request_id = 0
child = None
report = []


def send(message):
    server.stdin.write((json.dumps(message, ensure_ascii=False) + '\n').encode())
    server.stdin.flush()


def rpc(method, params=None):
    global request_id
    request_id += 1
    request = {'jsonrpc': '2.0', 'id': request_id, 'method': method}
    if params is not None:
        request['params'] = params
    send(request)
    deadline = time.monotonic() + 15
    while b'\n' not in pending:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not selector.select(remaining):
            raise RuntimeError(f'MCP deadline: {method}')
        data = os.read(server.stdout.fileno(), 65536)
        if not data:
            raise RuntimeError(f'MCP server exited: {method}')
        pending.extend(data)
    line, _, rest = pending.partition(b'\n')
    pending[:] = rest
    response = json.loads(line)
    assert response.get('id') == request_id, response
    assert 'error' not in response, response
    return response['result']


def tool(name, arguments):
    envelope = rpc('tools/call', {'name': name, 'arguments': arguments})
    result = envelope['structuredContent']
    assert not envelope.get('isError'), (name, result)
    for content in envelope.get('content', []):
        if content['type'] == 'image':
            suffix = '.png' if content['mimeType'] == 'image/png' else '.webp'
            (artifacts / f'mcp-state-{request_id}{suffix}').write_bytes(base64.b64decode(content['data']))
    # Keep evidence for this fixture, never the full inventory of user windows.
    if name != 'list_windows':
        report.append({'tool': name, 'arguments': arguments, 'result': result})
    return result


def interrupted(signum, frame):
    raise SystemExit(f'Interrupted by signal {signum}')


signal.signal(signal.SIGTERM, interrupted)
try:
    init = rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'macos-mcp-desktop-test', 'version': '1'}})
    preflight = init['_meta']['desktopPilot/desktopPreflight']
    if preflight.get('ready') is not True:
        print('SKIP: actual MCP worker is not ready:', preflight.get('reasons'))
        raise SystemExit(77)
    send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
    names = {tool['name'] for tool in rpc('tools/list')['tools']}
    assert names == {'list_windows', 'get_window_state', 'execute_semantic', 'execute_batch'}
    child = subprocess.Popen([fixture, 'fixture'], stdout=log, stderr=log)
    window_id = None
    for _ in range(50):
        matches = [w for w in tool('list_windows', {})['windows'] if w['pid'] == child.pid and w['title'] == 'DesktopPilot disposable macOS fixture']
        if len(matches) == 1:
            window_id = matches[0]['window_id']
            break
        assert len(matches) < 2, 'Fixture identity ambiguous'
        time.sleep(0.1)
    assert window_id is not None, 'Disposable fixture not found'

    def observe(mode='controls', **kwargs):
        return tool('get_window_state', {'window_id': window_id, 'mode': mode, **kwargs})

    def control(state, name, role):
        hits = [c for c in state['controls'] if c['name'] == name and c['role'] == role]
        assert len(hits) == 1, (name, hits)
        return hits[0]

    def execute(actions):
        result = tool('execute_batch', {'window_id': window_id, 'actions': actions})
        assert result['completed'] == len(actions), result
        return result

    def has_value(state, value):
        return any(c.get('value') == value for c in state['controls'])

    def await_value(value):
        for _ in range(20):
            state = observe()
            if has_value(state, value):
                return state
            time.sleep(0.05)
        raise AssertionError(f'Fixture did not expose expected value: {value}')

    state = observe('both')
    assert state['coordinateSpace'] == 'image_pixels'
    assert state['semantic']['profiles'] == [], 'No application profile expected'
    before = state['size']
    field = control(state, 'Pilot text', 'Edit')
    apply = control(state, 'Apply', 'Button')
    execute([{'type': 'fill_text', 'control_id': field['control_id'], 'text': 'MCP 中文 🌏'},
             {'type': 'click', 'control_id': apply['control_id']}])
    state = await_value('Applied: MCP 中文 🌏')
    field = control(state, 'Pilot text', 'Edit')
    execute([{'type': 'click', 'control_id': field['control_id']},
             {'type': 'press_keys', 'chord': 'Cmd+A'},
             {'type': 'type_text', 'text': 'Typed through MCP 中文 🌏'}])
    state = await_value('Typed through MCP 中文 🌏')
    apply = control(state, 'Apply', 'Button')
    x, y, w, h = apply['bounds']
    execute([{'type': 'click', 'point': {'x': x + w // 2, 'y': y + h // 2}}])
    state = await_value('Applied: Typed through MCP 中文 🌏')

    pad = control(state, 'Pilot pointer pad', 'Group')
    x, y, w, h = pad['bounds']
    path = [[x + 25, y + 25], [x + w // 2, y + h // 2], [x + w - 25, y + h - 25]]
    execute([{'type': 'move', 'points': path, 'hold': 'left'}])
    state = observe()
    values = [str(c.get('value', '')) for c in state['controls']]
    drags = [int(v.split(':')[1]) for v in values if v.startswith('Pointer drags:')]
    assert len(drags) == 1 and drags[0] >= 1, ('Held pointer path not delivered', values)

    execute([{'type': 'drag', 'from': {'x': x + 25, 'y': y + h - 25}, 'to': {'x': x + w - 25, 'y': y + 25}}])
    state = observe()
    values = [str(c.get('value', '')) for c in state['controls']]
    assert any(v.startswith('Pointer drags:') and int(v.split(':')[1]) >= 1 for v in values), values

    # A cropped Retina screenshot must map an image point back into this pad.
    region = {'x': x + 5, 'y': y + 5, 'width': w - 10, 'height': h - 10}
    state = observe('both', region=region)
    capture = state['capture']
    assert capture['width'] >= region['width'] and capture['height'] >= region['height']
    execute([{'type': 'click', 'point': {'x': capture['width'] // 2, 'y': capture['height'] // 2}}])
    state = await_value('Pointer drags:0')
    assert state['size'] == before, 'Observation/input changed fixture size'
    print('PASS actual MCP worker: four-tool schema, Unicode fill/type, Cmd+A, AX/pointer clicks, held paths, drag, Retina crop mapping')
finally:
    (artifacts / 'mcp-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if child is not None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    server.stdin.close()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
    selector.close()
    log.close()
