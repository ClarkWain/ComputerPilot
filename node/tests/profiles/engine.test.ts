import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileEngine, profileGeometryIssue } from '../../src/profiles/engine.js';

const classicWindow = {
  windowRef: 'w1', pid: 42, executable: 'mspaint.exe', className: 'MSPaintApp', dpi: 144,
  bounds: { x: 10, y: 10, width: 1800, height: 1350 }, enabled: true, minimized: false,
  foreground: true, client: { physical: { width: 1778, height: 1320 },
    dip96: { width: 1185, height: 880 } }, display: { dpi: 144, name: 'DISPLAY1' }
};
const classicTree = { status: 'ok', elements: [
  { elementRef: 'zoom', name: '100%', role: 'Text' },
  { elementRef: 'canvas', name: '画布', role: 'Pane' },
  { elementRef: 'ellipse', name: '椭圆形', role: 'ListItem' },
  { elementRef: 'primary', name: '颜色 1', role: 'Button' },
  { elementRef: 'secondary', name: '颜色 2', role: 'Button' },
  { elementRef: 'edit', name: '编辑颜色', role: 'Button' },
  { elementRef: 'brush', name: '刷子', role: 'Button' }
] };

test('v2 geometry compares physical client area against display DPI', async () => {
  const engine = new ProfileEngine(async () => { throw new Error('not called'); });
  const profile = await engine.load('mspaint-classic-zh-CN');
  assert.equal(profileGeometryIssue(profile, classicWindow), '');
  assert.equal(profileGeometryIssue(profile, { ...classicWindow,
    client: { ...classicWindow.client, physical: { width: 1600, height: 1320 } } }),
  'insufficient_client_area');
  assert.equal(profileGeometryIssue(profile, { ...classicWindow, client: undefined }), 'client_area_unknown');
  assert.equal(profileGeometryIssue(profile, { ...classicWindow, dpi: 120, display: { dpi: 120 },
    client: { physical: { width: 1356, height: 813 }, dip96: { width: 1085, height: 650 } } }), '');
});

test('discovery includes manifest action examples and does not scan UIA for a narrow client', async () => {
  const calls: string[] = [];
  const engine = new ProfileEngine(async op => {
    calls.push(op);
    if (op === 'window.get') return classicWindow;
    if (op === 'ui.tree') return classicTree;
    throw new Error(op);
  });
  const available = await engine.discover('w1');
  assert.equal(available.profiles[0].id, 'mspaint-classic-zh-CN');
  assert.ok(available.profiles[0].actions[0].example);
  assert.deepEqual(calls, ['window.get', 'ui.tree']);
  calls.length = 0;
  const narrow = await engine.discover('w1', { window: { ...classicWindow,
    client: { ...classicWindow.client, physical: { width: 1000, height: 1320 } } } });
  assert.equal(narrow.unavailable[0].reasons[0], 'insufficient_client_area');
  assert.deepEqual(calls, []);
});

test('semantic execution rejects stale input evidence before dispatch', async () => {
  const calls: string[] = [];
  let sessions = 0;
  const engine = new ProfileEngine(async op => {
    calls.push(op);
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true,
      lockState: 'unlocked', lastInputTick: ++sessions };
    if (op === 'window.get') return classicWindow;
    if (op === 'ui.tree') return classicTree;
    throw new Error(op);
  });
  const result = await engine.execute('w1', 'mspaint-classic-zh-CN', [
    { action: 'drawing.drawCircle', args: { center: [50, 50], radius: 10 } }
  ]);
  assert.equal(result.code, 'profile_evidence_stale');
  assert.equal(result.dispatch, 'not_started');
  assert.deepEqual(calls, ['system.session', 'window.get', 'ui.tree', 'system.session', 'window.get']);
});

test('Paint discovery requires complete, unique control evidence', async () => {
  const engine = new ProfileEngine(async () => { throw new Error('not called'); });
  const duplicate = { ...classicTree.elements[0], elementRef: 'duplicate-zoom',
    bounds: { x: 40, y: 0, width: 10, height: 10 } };
  for (const elements of [classicTree.elements, [...classicTree.elements, duplicate]]) {
    for (const flags of [
      { truncated: true, evidenceComplete: false },
      { truncated: false, evidenceComplete: true }
    ]) {
      const result = await engine.discover('w1', { window: classicWindow,
        tree: { ...classicTree, elements, stopReason: 'depthLimit', ...flags } });
      assert.deepEqual(result.profiles, []);
      assert.ok(result.unavailable[0].reasons.includes('ui_inspection_incomplete'));
    }
  }
  const ambiguous = await engine.discover('w1', { window: classicWindow,
    tree: { ...classicTree, elements: [...classicTree.elements, duplicate], stopReason: 'complete' } });
  assert.deepEqual(ambiguous.profiles, []);
  assert.ok(ambiguous.unavailable[0].reasons.includes('control_not_unique:zoom'));
  const unique = await engine.discover('w1', { window: classicWindow, tree: classicTree });
  assert.equal(unique.profiles[0].id, 'mspaint-classic-zh-CN');
});

test('Paint semantic execution stops before input on depth-truncated evidence', async () => {
  const calls: string[] = [];
  const engine = new ProfileEngine(async op => {
    calls.push(op);
    if (op === 'system.session') return { inputDesktopAccessible: true, lockState: 'unlocked' };
    if (op === 'window.get') return classicWindow;
    if (op === 'ui.tree') return { ...classicTree, stopReason: 'depthLimit',
      truncated: true, evidenceComplete: false };
    throw new Error(op);
  });
  const result = await engine.execute('w1', 'mspaint-classic-zh-CN', [
    { action: 'drawing.drawCircle', args: { center: [50, 50], radius: 10 } }
  ]);
  assert.equal(result.code, 'profile_inspection_incomplete');
  assert.equal(result.dispatch, 'not_started');
  assert.equal(result.completed, 0);
  assert.deepEqual(calls, ['system.session', 'window.get', 'ui.tree']);
});

test('Aseprite OCR actions are advertised after Node OCR routing is available', async () => {
  const aseprite = { ...classicWindow, executable: 'aseprite.exe', className: 'Aseprite.Window', dpi: 96,
    bounds: { ...classicWindow.bounds, width: 2578, height: 1398 }, display: { dpi: 96 }, client: undefined };
  const engine = new ProfileEngine(async op => op === 'window.get' ? aseprite :
    op === 'ui.tree' ? { status: 'ok', elements: [] } :
      op === 'capture.region' ? { status: 'ok', path: 'mock.png' } :
        op === 'vision.ocr' ? { status: 'ok', textLines: [{ text: 'File', recognitionScore: .9,
          bounds: { x: 10, y: 5, width: 40, height: 12 } }] } : { status: 'ok' });
  const result = await engine.discover('w1');
  const actions = result.profiles[0].actions.map((a: any) => a.action);
  assert.ok(actions.includes('aseprite.keyChord'));
  assert.ok(actions.includes('aseprite.openMenu'));
  assert.ok(actions.includes('aseprite.saveAsDefault'));
});

test('saveAsDefault is hidden for a different Aseprite window size or DPI', async () => {
  const aseprite = { ...classicWindow, executable: 'aseprite.exe', className: 'Aseprite.Window', dpi: 144,
    bounds: { ...classicWindow.bounds, width: 2578, height: 1398 }, display: { dpi: 144 }, client: undefined };
  const engine = new ProfileEngine(async op => op === 'window.get' ? aseprite :
    op === 'ui.tree' ? { status: 'ok', elements: [] } :
      op === 'capture.region' ? { status: 'ok', path: 'mock.png' } :
        op === 'vision.ocr' ? { status: 'ok', textLines: [{ text: 'File', recognitionScore: .9,
          bounds: { x: 10, y: 5, width: 40, height: 12 } }] } : { status: 'ok' });
  const result = await engine.discover('w1');
  const actions = result.profiles[0].actions.map((a: any) => a.action);
  assert.ok(actions.includes('aseprite.openMenu'));
  assert.ok(!actions.includes('aseprite.saveAsDefault'));
});

test('English Aseprite profile is unavailable when its menu language is unconfirmed', async () => {
  const aseprite = { ...classicWindow, executable: 'aseprite.exe', className: 'Aseprite.Window', dpi: 96,
    bounds: { ...classicWindow.bounds, width: 1000 }, display: { dpi: 96 }, client: undefined };
  const engine = new ProfileEngine(async op => op === 'window.get' ? aseprite :
    op === 'ui.tree' ? { status: 'ok', elements: [] } :
      op === 'capture.region' ? { status: 'ok', path: 'mock.png' } :
        op === 'vision.ocr' ? { status: 'ok', textLines: [{ text: '文件', recognitionScore: .9,
          bounds: { x: 10, y: 5, width: 40, height: 12 } }] } : { status: 'ok' });
  const result = await engine.discover('w1');
  assert.deepEqual(result.profiles, []);
  assert.deepEqual(result.unavailable[0].reasons, ['visual_menu_not_confirmed']);
});

test('unmatched semantic result omits the full UI tree', async () => {
  const aseprite = { ...classicWindow, executable: 'aseprite.exe', className: 'Aseprite.Window', dpi: 96,
    bounds: { ...classicWindow.bounds, width: 1000 }, display: { dpi: 96 }, client: undefined };
  const engine = new ProfileEngine(async op => op === 'system.session' ?
    { status: 'ok', inputDesktopAccessible: true, lockState: 'unlocked', lastInputTick: 1 } :
    op === 'window.get' ? aseprite : op === 'ui.tree' ? { status: 'ok', elements: [] } :
      op === 'capture.region' ? { status: 'ok', path: 'mock.png' } :
        op === 'vision.ocr' ? { status: 'ok', textLines: [] } : { status: 'ok' });
  const result = await engine.execute('w1', 'aseprite-vision-en', [
    { action: 'aseprite.openMenu', args: { name: 'View' } }
  ]);
  assert.equal(result.code, 'profile_not_matched');
  assert.equal(result.dispatch, 'not_started');
  assert.equal('inspection' in result.semantic, false);
});

test('cancellation after compatibility checks stops semantic input', async () => {
  const controller = new AbortController();
  let reads = 0, inputCalls = 0;
  const aseprite = { ...classicWindow, executable: 'aseprite.exe', className: 'Aseprite.Window', dpi: 96,
    bounds: { ...classicWindow.bounds, width: 1000 }, display: { dpi: 96 }, client: undefined };
  const engine = new ProfileEngine(async op => {
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true,
      lockState: 'unlocked', lastInputTick: 1 };
    if (op === 'window.get') { if (++reads === 2) controller.abort(); return aseprite; }
    if (op === 'ui.tree') return { status: 'ok', elements: [] };
    if (op.startsWith('input.')) inputCalls++;
    return { status: 'ok' };
  });
  const result = await engine.execute('w1', 'aseprite-vision-en', [
    { action: 'aseprite.keyChord', args: { keys: ['CTRL', 'Z'] } }
  ], { signal: controller.signal });
  assert.equal(result.dispatch, 'not_started');
  assert.equal(inputCalls, 0);
});
