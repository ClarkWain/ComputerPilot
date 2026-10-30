import { checked, complete, equal, int, point, rgb, keysOnly, sleep,
  type Action, type NativeCall, type Profile } from './common.js';

function validate(item: Action): void {
  const a = item.args ?? {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('args must be an object');
  if (item.action === 'drawing.selectBrush') {
    keysOnly(a, ['brush']);
    if (!['brush', 'pencil'].includes(a.brush)) throw new Error('Supported brushes: brush, pencil');
  } else if (item.action === 'drawing.setColor') { keysOnly(a, ['color']); rgb(a.color); }
  else if (item.action === 'drawing.setStrokeWidth') { keysOnly(a, ['width']); width(a.width); }
  else if (item.action === 'drawing.fillAt') { keysOnly(a, ['position', 'color']); point(a.position); rgb(a.color); }
  else if (item.action === 'drawing.drawPolyline') {
    keysOnly(a, ['points', 'closed', 'stroke']);
    if (!Array.isArray(a.points) || a.points.length < 2 || a.points.length > 4095)
      throw new Error('Polyline requires 2..4095 points');
    for (let i = 0; i < a.points.length; i++) {
      point(a.points[i]);
      if (i && equal(a.points[i], a.points[i - 1])) throw new Error('Repeated adjacent point');
    }
    if (a.closed !== undefined && typeof a.closed !== 'boolean') throw new Error('closed must be boolean');
    if (!a.stroke || typeof a.stroke !== 'object') throw new Error('stroke required');
    keysOnly(a.stroke, ['color', 'width']); rgb(a.stroke.color); width(a.stroke.width);
  } else throw new Error('Unsupported modern Paint action');
}
function width(value: unknown): number {
  const n = int(value, 1, 30);
  if (n > 24 && n % 2) throw new Error('Supported widths: 1..24, 26, 28, 30 pixels');
  return n;
}

export async function runModern(nativeCall: NativeCall, windowRef: string, profile: Profile,
  actions: Action[]): Promise<any> {
  try { actions.forEach(validate); }
  catch (error: any) { return { status: 'error', code: 'invalid_semantic_args', dispatch: 'not_started',
    completed: 0, message: String(error?.message ?? error) }; }
  let calls = 0, completed = 0, phase = 'preflight', drawn = false;
  const call = async (op: string, args: Record<string, unknown>) => { calls++; return checked(nativeCall, op, args); };
  const selectors = profile.selectors;
  const cache = new Map<string, any>();
  const find = async (selector: any, depth = 20): Promise<any> => {
    const key = JSON.stringify(selector);
    const cached = cache.get(key);
    if (cached) {
      try { return await call('ui.get', { elementRef: cached.elementRef }); }
      catch { cache.delete(key); }
    }
    const result = await call('ui.find', { windowRef, selector, depth, limit: 2,
      format: 'full', queryTimeoutMs: 5000 });
    if (!complete(result) || result.elements.length !== 1)
      throw new Error(!complete(result) ? 'ui_inspection_incomplete' : `control_not_unique: ${key}`);
    cache.set(key, result.elements[0]);
    return result.elements[0];
  };
  const findLargest = async (selector: any): Promise<any> => {
    const result = await call('ui.find', { windowRef, selector, depth: 16, limit: 128,
      format: 'full', queryTimeoutMs: 5000 });
    if (!complete(result)) throw new Error('ui_inspection_incomplete');
    const matches = result.elements.filter((e: any) => e.enabled !== false && !e.offscreen && e.bounds);
    matches.sort((a: any, b: any) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height);
    if (!matches.length) throw new Error(`no_visible_match: ${JSON.stringify(selector)}`);
    return matches[0];
  };
  const select = async (selector: any) => {
    const e = await find(selector);
    await call('ui.click', { windowRef, elementRef: e.elementRef });
    await sleep(60);
  };
  const key = async (name: string) => { await call('input.key_chord', { windowRef, keys: [name] }); };
  let canvasRef: string | undefined;
  const readCanvas = async (): Promise<any> => {
    if (canvasRef) {
      try { return await call('ui.get', { elementRef: canvasRef }); }
      catch { canvasRef = undefined; }
    }
    const c = await findLargest(selectors.canvas); canvasRef = c.elementRef; return c;
  };
  const canvas = async (): Promise<any> => {
    const zoom = await find(selectors.zoom);
    if (zoom.value !== '100 百分比') throw new Error('requires_100_percent_zoom');
    const c = await readCanvas(), w = await call('window.get', { windowRef });
    const b = c.bounds, wb = w.bounds;
    const x = b.x - wb.x, y = b.y - wb.y;
    if (x < 0 || y < 0 || x + b.width > wb.width || y + b.height > wb.height || b.width < 2 || b.height < 2)
      throw new Error('requires_fully_visible_canvas');
    return { x, y, width: b.width, height: b.height, windowBounds: wb, canvasBounds: b };
  };
  const setColor = async (color: number[]) => {
    await select(selectors.primary); await select(selectors.editColors);
    const field = await findLargest({ automationId: 'HexTextBox', role: 'Edit' });
    const hex = `#${color.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    const filled = await call('ui.fill', { windowRef, elementRef: field.elementRef, text: hex, method: 'auto' });
    if (filled.verification !== 'passed') throw new Error('color_fill_failed');
    await call('ui.focus', { elementRef: field.elementRef }); await key('TAB'); await sleep(80);
    await call('ui.focus', { elementRef: field.elementRef }); await key('ENTER'); await sleep(100);
    await find(selectors.primary);
  };
  const brush = async (name: string) => {
    if (name === 'pencil') await select(selectors.pencil);
    else {
      const e = await find(selectors.brush), w = await call('window.get', { windowRef });
      await call('input.click', { windowRef, coordinateSpace: 'window_relative',
        x: e.bounds.x + Math.floor(e.bounds.width / 2) - w.bounds.x,
        y: e.bounds.y + Math.floor(e.bounds.height / 3) - w.bounds.y });
      await sleep(60);
    }
    const c = await readCanvas();
    if (!String(c.name).includes(name === 'pencil' ? '铅笔' : '画笔')) throw new Error('brush_readback_mismatch');
  };
  const setWidth = async (n: number) => {
    const e = await find(selectors.width);
    await call('ui.set_range_value', { elementRef: e.elementRef, value: n <= 24 ? n - 1 : 23 + (n - 24) / 2 });
    await sleep(60);
    if ((await call('ui.get', { elementRef: e.elementRef })).value !== `${n} 像素`)
      throw new Error('width_readback_mismatch');
  };
  try {
    const session = await call('system.session', {});
    if (!session.inputDesktopAccessible || session.lockState === 'locked') throw new Error('interactive_desktop_unavailable');
    const host = await call('window.get', { windowRef });
    if (!host.enabled || host.minimized) throw new Error('unsupported_window_state');
    await call('window.activate', { windowRef });
    const initial = await canvas();
    for (const item of actions) {
      const a = item.args ?? {};
      const positions = a.points ?? (a.position ? [a.position] : []);
      for (const p of positions) if (p[0] >= initial.width || p[1] >= initial.height)
        throw new Error('point_outside_canvas');
    }
    let lastColor: any, lastFillColor: any, lastBrush = '', lastWidth = -1, opacityReady = false;
    const ensureBrush = async (name: string) => { if (lastBrush !== name) { await brush(name); lastBrush = name; } };
    const ensureColor = async (value: number[]) => {
      if (!equal(lastColor, value)) { await setColor(value); lastColor = value; lastFillColor = undefined; opacityReady = false; }
    };
    const ensureWidth = async (n: number) => { if (lastWidth !== n) { await setWidth(n); lastWidth = n; } };
    const ensureFillColor = async (value: number[]) => {
      if (!equal(lastFillColor, value)) { await setColor(value); lastFillColor = value; lastColor = undefined; opacityReady = false; }
    };
    for (const item of actions) {
      phase = 'setup';
      const a = item.args ?? {};
      if (item.action === 'drawing.selectBrush') await ensureBrush(a.brush);
      else if (item.action === 'drawing.setColor') await ensureColor(a.color);
      else if (item.action === 'drawing.setStrokeWidth') await ensureWidth(a.width);
      else {
        if (item.action === 'drawing.drawPolyline') {
          await ensureBrush('brush'); await ensureColor(a.stroke.color); await ensureWidth(a.stroke.width);
          if (!opacityReady) {
            const opacity = await find(selectors.opacity);
            await call('ui.focus', { elementRef: opacity.elementRef }); await key('END');
            if ((await call('ui.get', { elementRef: opacity.elementRef })).value !== '100%')
              throw new Error('opacity_readback_mismatch');
            opacityReady = true;
          }
        } else { await ensureFillColor(a.color); await select(selectors.fill); lastBrush = ''; }
        const c = await canvas();
        if (!equal(c, initial)) throw new Error('canvas_layout_changed');
        phase = 'draw'; drawn = true;
        if (item.action === 'drawing.drawPolyline') {
          const points = a.points.map((p: number[]) => [c.x + p[0], c.y + p[1]]);
          if (a.closed && !equal(points[0], points[points.length - 1])) points.push(points[0]);
          await call('input.move', { windowRef, coordinateSpace: 'window_relative', expectedSize: c.windowBounds,
            points, hold: 'left' });
        } else await call('input.click', { windowRef, coordinateSpace: 'window_relative',
          expectedSize: c.windowBounds, x: c.x + a.position[0], y: c.y + a.position[1] });
      }
      completed++;
    }
    return { status: 'ok', completed, total: actions.length, nativeCalls: calls,
      verification: 'settings_readback_and_actions_dispatched', canvasOrigin: [initial.x, initial.y], canvasScale: 1 };
  } catch (error: any) {
    return { status: 'error', phase, completed, failedIndex: completed, drawAttempted: drawn,
      dispatch: drawn ? 'possibly_partial' : 'not_started', nativeCalls: calls,
      message: String(error?.message ?? error) };
  }
}
