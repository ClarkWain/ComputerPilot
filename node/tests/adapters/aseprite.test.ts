import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { runAseprite } from '../../src/adapters/aseprite.js';
import { ProfileEngine } from '../../src/profiles/engine.js';

test('Aseprite hotkey batch reuses window and reports partial dispatch', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('aseprite-vision-en');
  const dispatched: any[] = [];
  const call = async (op: string, args: any): Promise<any> => {
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true, lockState: 'unlocked' };
    if (op === 'window.get') return { status: 'ok', enabled: true, minimized: false, foreground: true,
      bounds: { x: 0, y: 0, width: 1000, height: 800 } };
    if (op === 'input.key_chord') { dispatched.push(args.keys); return { status: 'ok' }; }
    if (op === 'input.click') return { status: 'error', message: 'blocked' };
    throw new Error(op);
  };
  const result = await runAseprite(call, 'w1', profile, [
    { action: 'aseprite.selectTool', args: { tool: 'pencil' } },
    { action: 'aseprite.click', args: { x: 100, y: 100 } }
  ]);
  assert.deepEqual(dispatched, [['B']]);
  assert.equal(result.completed, 1);
  assert.equal(result.failedIndex, 1);
  assert.equal(result.dispatch, 'possibly_partial');
});

test('Aseprite openMenu uses OCR evidence and clicks within the menu strip', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('aseprite-vision-en');
  const seen: Array<{ op: string; args: any }> = [];
  const result = await runAseprite(async (op, args) => {
    seen.push({ op, args });
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true, lockState: 'unlocked' };
    if (op === 'window.get') return { status: 'ok', enabled: true, minimized: false, foreground: true,
      dpi: 96, bounds: { x: 100, y: 200, width: 2578, height: 1398 } };
    if (op === 'capture.region') return { status: 'ok', path: 'mock-strip.png' };
    if (op === 'vision.ocr') return { status: 'ok', textLines: [{ text: 'File Edit',
      recognitionScore: 0.9, bounds: { x: 20, y: 5, width: 90, height: 12 } }] };
    return { status: 'ok' };
  }, 'w1', profile, [{ action: 'aseprite.openMenu', args: { name: 'File' } }]);
  assert.equal(result.status, 'ok');
  assert.equal(result.lastResult.menu, 'File');
  assert.equal(result.lastResult.ocrScore, 0.9);
  const click = seen.find(entry => entry.op === 'input.click');
  assert.deepEqual([click?.args.x, click?.args.y], [40, 11]);
  assert.equal(click?.args.coordinateSpace, 'window_relative');
});

test('Aseprite openMenu rejects weak OCR without input', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('aseprite-vision-en');
  let clicks = 0;
  const result = await runAseprite(async op => {
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true, lockState: 'unlocked' };
    if (op === 'window.get') return { status: 'ok', enabled: true, minimized: false, foreground: true,
      dpi: 96, bounds: { x: 100, y: 200, width: 2578, height: 1398 } };
    if (op === 'capture.region') return { status: 'ok', path: 'mock-strip.png' };
    if (op === 'vision.ocr') return { status: 'ok', textLines: [{ text: 'File',
      recognitionScore: 0.1, bounds: { x: 20, y: 5, width: 40, height: 12 } }] };
    if (op === 'input.click') clicks++;
    return { status: 'ok' };
  }, 'w1', profile, [{ action: 'aseprite.openMenu', args: { name: 'File' } }]);
  assert.equal(result.status, 'error');
  assert.equal(result.dispatch, 'not_started');
  assert.equal(result.phase, 'ocr');
  assert.equal(clicks, 0);
});

test('Aseprite saveAsDefault blocks recorded coordinates on a different window size', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('aseprite-vision-en');
  let clicks = 0;
  const result = await runAseprite(async op => {
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true, lockState: 'unlocked' };
    if (op === 'window.get') return { status: 'ok', enabled: true, minimized: false, foreground: true,
      dpi: 96, bounds: { x: 100, y: 200, width: 1200, height: 800 } };
    if (op === 'input.click') clicks++;
    return { status: 'ok' };
  }, 'w1', profile, [{ action: 'aseprite.saveAsDefault', args: {} }]);
  assert.equal(result.status, 'error');
  assert.match(result.message, /save_dialog_window_size_mismatch/);
  assert.equal(result.dispatch, 'not_started');
  assert.equal(clicks, 0);
});

test('150% DPI menu OCR uses physical strip pixels once and removes its capture', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('aseprite-vision-en');
  let output = '', capture: any, click: any;
  const result = await runAseprite(async (op, args) => {
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true, lockState: 'unlocked' };
    if (op === 'window.get') return { status: 'ok', enabled: true, minimized: false, foreground: true,
      dpi: 144, bounds: { x: 100, y: 200, width: 1800, height: 1200 } };
    if (op === 'capture.region') {
      capture = args; output = String(args.output); await writeFile(output, 'mock');
      return { status: 'ok', path: output };
    }
    if (op === 'vision.ocr') return { status: 'ok', textLines: [{ text: 'View', recognitionScore: .9,
      bounds: { x: 42, y: 12, width: 60, height: 20 } }] };
    if (op === 'input.click') click = args;
    return { status: 'ok' };
  }, 'w1', profile, [{ action: 'aseprite.openMenu', args: { name: 'View' } }]);
  assert.equal(result.status, 'ok');
  assert.deepEqual([capture.x, capture.y, capture.width, capture.height], [100, 200, 1800, 90]);
  assert.deepEqual([click.x, click.y], [72, 22]);
  assert.equal(existsSync(output), false);
});

test('capture failure reports capture phase and dispatch not started', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('aseprite-vision-en');
  const result = await runAseprite(async op => {
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true, lockState: 'unlocked' };
    if (op === 'window.get') return { status: 'ok', enabled: true, minimized: false, foreground: true,
      dpi: 96, bounds: { x: 0, y: 0, width: 1800, height: 1200 } };
    if (op === 'capture.region') return { status: 'error', message: 'capture unavailable' };
    throw new Error('unexpected ' + op);
  }, 'w1', profile, [{ action: 'aseprite.openMenu', args: { name: 'View' } }]);
  assert.equal(result.status, 'error');
  assert.equal(result.phase, 'capture');
  assert.equal(result.dispatch, 'not_started');
});

test('saveAsDefault reports partial outcome when overwrite warning lacks a verified Yes button', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('aseprite-vision-en');
  profile.menuSettleMs = 0;
  let ocrCalls = 0, clicks = 0;
  const result = await runAseprite(async op => {
    if (op === 'system.session') return { status: 'ok', inputDesktopAccessible: true, lockState: 'unlocked' };
    if (op === 'window.get') return { status: 'ok', enabled: true, minimized: false, foreground: true,
      dpi: 96, bounds: { x: 0, y: 0, width: 2578, height: 1398 } };
    if (op === 'capture.region' || op === 'capture.window') return { status: 'ok', path: 'mock.png' };
    if (op === 'vision.ocr') return ++ocrCalls === 1 ? { status: 'ok', textLines: [
      { text: 'File', recognitionScore: .9, bounds: { x: 10, y: 5, width: 40, height: 12 } }
    ] } : { status: 'ok', textLines: [
      { text: 'Warning: file exists', recognitionScore: .9, bounds: { x: 100, y: 100, width: 200, height: 20 } }
    ] };
    if (op === 'input.click') clicks++;
    return { status: 'ok' };
  }, 'w1', profile, [{ action: 'aseprite.saveAsDefault', args: {} }]);
  assert.equal(result.status, 'error');
  assert.equal(result.dispatch, 'possibly_partial');
  assert.match(result.message, /overwrite_confirmation_missing/);
  assert.equal(clicks, 3);
});
