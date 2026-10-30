import { readFile, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { checked, complete, equal, int, point, rgb, keysOnly, selectorMatches, sleep,
  centerClick, type Action, type NativeCall, type Profile } from './common.js';

type Shape = { item: Action; tool: string; vertices?: number[][]; box: [number, number, number, number];
  stroke: Record<string, any>; fill: number[] | null | undefined; path: boolean; polygon: boolean; text: boolean };

function paintPolygonVertices(input: number[][]): number[][] {
  const closed = [...input, input[0]], reduced: number[][] = [];
  const simplify = (first: number, last: number) => {
    if (last <= first + 1) { reduced.push(closed[first]); return; }
    const [ax, ay] = closed[first], dx = closed[last][0] - ax, dy = closed[last][1] - ay;
    let maximum = 0, split = first;
    for (let i = first + 1; i < last; i++) {
      const px = closed[i][0] - ax, py = closed[i][1] - ay;
      const t = dx * dx + dy * dy ? Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy))) : 0;
      const distance = Math.hypot(px - t * dx, py - t * dy);
      if (distance > maximum) { maximum = distance; split = i; }
    }
    if (maximum > 1) { simplify(first, split); simplify(split, last); }
    else reduced.push(closed[first]);
  };
  simplify(0, closed.length - 1);
  const vertices = reduced.length >= 3 ? reduced : input;
  let start = 0, longest = -1;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (distance > longest) { longest = distance; start = i; }
  }
  return [...vertices.slice(start), ...vertices.slice(0, start)];
}

function validate(item: Action, profile: Profile): Shape | null {
  const a = item.args ?? {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('args must be an object');
  if (item.action === 'drawing.selectBrush') {
    keysOnly(a, ['brush']);
    if (!(a.brush in profile.brushes)) throw new Error('Unknown brush');
    return null;
  }
  if (item.action === 'document.saveAs') {
    keysOnly(a, ['path', 'format', 'overwrite']);
    if (a.format !== undefined && a.format !== 'png') throw new Error('Only PNG is supported');
    if (typeof a.path !== 'string' || !win32.isAbsolute(a.path) || win32.extname(a.path).toLowerCase() !== '.png')
      throw new Error('Absolute .png path required');
    if (a.overwrite) throw new Error('Overwrite is not supported; choose a new path');
    return null;
  }
  if (item.action === 'document.setCanvasSize') {
    keysOnly(a, ['width', 'height']);
    int(a.width, 1, 10000); int(a.height, 1, 10000);
    return null;
  }
  const tool: Record<string, string> = { 'drawing.drawCircle': 'ellipse', 'drawing.drawEllipse': 'ellipse',
    'drawing.drawRectangle': 'rectangle', 'drawing.drawRoundedRectangle': 'roundedRectangle',
    'drawing.drawLine': 'line', 'drawing.drawPolyline': 'brushMenu', 'drawing.drawPolygon': 'polygon',
    'drawing.drawText': 'text' };
  if (!tool[item.action]) throw new Error('Unsupported semantic profile/action');
  const path = item.action === 'drawing.drawPolyline', polygon = item.action === 'drawing.drawPolygon',
    text = item.action === 'drawing.drawText', line = path || item.action === 'drawing.drawLine';
  let box: [number, number, number, number];
  let vertices: number[][] | undefined;
  if (path || polygon) {
    keysOnly(a, path ? ['points', 'closed', 'stroke'] : ['points', 'stroke', 'fill']);
    if (!Array.isArray(a.points) || a.points.length < (polygon ? 3 : 2) || a.points.length > (polygon ? 128 : 4095))
      throw new Error(path ? 'Polyline requires 2..4095 points' : 'Polygon requires 3..128 points');
    vertices = a.points.map((p: unknown) => [...point(p)]);
    for (let i = 1; i < vertices.length; i++) if (equal(vertices[i], vertices[i - 1]))
      throw new Error('Repeated adjacent point');
    if (polygon) {
      if (equal(vertices[0], vertices[vertices.length - 1])) throw new Error('Polygon closes automatically');
      const area = vertices.reduce((sum, p, i) => {
        const q = vertices![(i + 1) % vertices!.length]; return sum + p[0] * q[1] - q[0] * p[1];
      }, 0);
      if (!area) throw new Error('Degenerate polygon');
      vertices = paintPolygonVertices(vertices);
    } else if (a.closed !== undefined && typeof a.closed !== 'boolean') throw new Error('closed must be boolean');
    const xs = vertices.map(p => p[0]), ys = vertices.map(p => p[1]);
    box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  } else if (item.action === 'drawing.drawCircle') {
    keysOnly(a, ['center', 'radius', 'stroke', 'fill']);
    const [cx, cy] = point(a.center), radius = int(a.radius, 2, 8000);
    box = [cx - radius, cy - radius, cx + radius - 1, cy + radius - 1];
  } else if (line) {
    keysOnly(a, ['from', 'to', 'stroke']);
    const from = point(a.from), to = point(a.to);
    if (equal(from, to)) throw new Error('Line endpoints must differ');
    box = [from[0], from[1], to[0], to[1]];
  } else {
    keysOnly(a, text ? ['position', 'size', 'text', 'stroke'] : ['position', 'size', 'stroke', 'fill']);
    const [x, y] = point(a.position), [w, h] = point(a.size);
    if (w < 2 || h < 2) throw new Error('Shape size must be at least two pixels');
    if (text && (typeof a.text !== 'string' || !a.text)) throw new Error('Nonempty text required');
    box = [x, y, x + w - 1, y + h - 1];
  }
  if (Math.min(...box) < 0 || Math.max(...box) > 32000) throw new Error('Shape extends outside coordinate range');
  const stroke = a.stroke ?? {};
  if (!stroke || typeof stroke !== 'object' || Array.isArray(stroke)) throw new Error('stroke must be an object');
  keysOnly(stroke, ['color', 'width']);
  if (stroke.color !== undefined) rgb(stroke.color);
  if (stroke.width !== undefined) {
    if (text) throw new Error('Text stroke.width is not supported');
    const width = int(stroke.width, 1, 8);
    if (!(String(width) in profile.widthOptions)) throw new Error('Unsupported stroke width for profile');
  }
  if (a.fill != null) rgb(a.fill);
  return { item, tool: tool[item.action], vertices, box, stroke, fill: a.fill,
    path, polygon, text };
}

export async function runClassic(nativeCall: NativeCall, windowRef: string, profile: Profile,
  actions: Action[], initialTree?: any): Promise<any> {
  let shapes: Array<Shape | null>;
  try {
    shapes = actions.map(item => validate(item, profile));
    for (const item of actions) if (item.action === 'document.saveAs') {
      const target = item.args!.path;
      try { await stat(target); throw new Error('Target already exists'); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      const parent = await stat(win32.dirname(target));
      if (!parent.isDirectory()) throw new Error('Parent directory does not exist');
    }
  } catch (error: any) {
    return { status: 'error', code: 'invalid_semantic_args', dispatch: 'not_started', completed: 0,
      message: String(error?.message ?? error) };
  }
  let calls = 0, completed = 0, phase = 'preflight', dispatched = false;
  const state: { tool?: string; activeTool?: string; values: Record<string, any>; tree?: any } = { values: {}, tree: initialTree };
  const call = async (op: string, args: Record<string, unknown>) => { calls++; return checked(nativeCall, op, args); };
  let window: any;
  const selectors = profile.selectors;
  const treeCache = new Map<string, any>();
  if (initialTree && complete(initialTree)) treeCache.set(windowRef, initialTree);
  const find = async (host: string, selector: any): Promise<string> => {
    let tree = treeCache.get(host);
    if (!tree) {
      tree = await call('ui.tree', { windowRef: host, depth: 16, limit: 400, format: 'locator', queryTimeoutMs: 10000 });
      treeCache.set(host, tree);
    }
    if (!complete(tree)) throw new Error('ui_inspection_incomplete');
    const found = tree.elements.filter((element: any) => selectorMatches(element, selector));
    if (found.length !== 1)
      throw new Error(`control_not_unique: ${JSON.stringify(selector)} (matches=${found.length}, tree=${tree.elements.length}, stop=${tree.stopReason})`);
    return found[0].elementRef;
  };
  const click = async (host: string, ref: string) => {
    dispatched = true;
    if (profile.useControlInvoke) await call('ui.click', { windowRef: host, elementRef: ref });
    else await centerClick(call, host, ref);
    await sleep(profile.clickSettleMs ?? 20);
  };
  const popup = async (title = ''): Promise<string> => {
    for (let i = 0; i < 100; i++) {
      const list = await call('window.list', { pid: window.pid, titleContains: title });
      const candidates = list.windows.filter((w: any) => w.windowRef !== windowRef &&
        w.foreground === true && w.enabled !== false && w.visible !== false);
      if (candidates.length === 1) return candidates[0].windowRef;
      await sleep(profile.popupPollMs ?? 20);
    }
    throw new Error('expected_popup_not_ready');
  };
  const menu = async (key: string, selector: any) => {
    phase = key;
    await click(windowRef, await find(windowRef, selectors[key]));
    const host = await popup();
    treeCache.delete(host);
    dispatched = true;
    await call('ui.click', { windowRef: host, elementRef: await find(host, selector) });
    const flyoutOpen = async () => (await call('window.list', { pid: window.pid })).windows
      .some((w: any) => w.windowRef !== windowRef && w.visible !== false);
    for (let i = 0; i < 4 && await flyoutOpen(); i++) await sleep(profile.popupPollMs ?? 20);
    for (let tries = 0; tries < 3 && await flyoutOpen(); tries++) {
      await call('window.activate', { windowRef });
      try { await call('input.key_chord', { windowRef, keys: ['Escape'] }); } catch { /* best effort */ }
      for (let i = 0; i < 6 && await flyoutOpen(); i++) await sleep(profile.popupPollMs ?? 20);
    }
  };
  const setColor = async (slot: 'primary' | 'secondary', color: number[]) => {
    phase = `${slot}Color`;
    await click(windowRef, await find(windowRef, selectors[slot]));
    await click(windowRef, await find(windowRef, selectors.editColors));
    const host = await popup(profile.colorDialogTitle);
    treeCache.delete(host);
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ref = await find(host, profile.rgbFields[i]); refs.push(ref);
      await call('ui.set_value', { elementRef: ref, value: String(color[i]) });
    }
    for (let i = 0; i < 3; i++) if ((await call('ui.get', { elementRef: refs[i] })).value !== String(color[i]))
      throw new Error('RGB_readback_mismatch');
    await call('ui.invoke', { elementRef: await find(host, profile.colorConfirm) });
    let closed = false;
    for (let i = 0; i < 30; i++) {
      const list = await call('window.list', { pid: window.pid, titleContains: profile.colorDialogTitle });
      if (!list.windows.some((w: any) => w.windowRef !== windowRef && w.visible !== false)) {
        closed = true;
        break;
      }
      await sleep(100);
    }
    if (!closed) throw new Error('color_dialog_not_closed');
  };
  const perform = async (item: Action, shape: Shape | null): Promise<void> => {
    const a = item.args ?? {};
    const session = await call('system.session', {});
    if (!session.inputDesktopAccessible || session.lockState === 'locked') throw new Error('interactive_desktop_unavailable');
    window = await call('window.get', { windowRef });
    if (!window.enabled || window.minimized) throw new Error('unsupported_window_state');
    if (!window.foreground) await call('window.activate', { windowRef });
    if (item.action === 'document.setCanvasSize') {
      phase = 'openImageProperties';
      dispatched = true;
      await call('input.key_chord', { windowRef, keys: ['CTRL', 'E'] });
      const host = await popup(profile.canvasSize.dialogTitle);
      treeCache.delete(host);
      phase = 'setCanvasSize';
      await click(host, await find(host, profile.canvasSize.pixels));
      treeCache.delete(host);
      for (const [key, value] of [['width', a.width], ['height', a.height]] as const) {
        const ref = await find(host, profile.canvasSize[key]);
        await call('ui.set_value', { elementRef: ref, value: String(value) });
        if ((await call('ui.get', { elementRef: ref })).value !== String(value))
          throw new Error(`${key}_readback_mismatch`);
      }
      await click(host, await find(host, profile.canvasSize.confirm));
      for (let i = 0; i < 30; i++) {
        if (!(await call('window.list', { pid: window.pid, titleContains: profile.canvasSize.dialogTitle })).windows
          .some((w: any) => w.windowRef !== windowRef && w.visible !== false)) return;
        await sleep(100);
      }
      throw new Error('image_properties_dialog_not_closed');
    }
    if (item.action === 'drawing.selectBrush' || item.action === 'document.saveAs') {
      state.values = {}; state.tool = undefined; state.activeTool = undefined;
      const save = item.action === 'document.saveAs';
      phase = save ? 'openSave' : 'openBrush';
      let host: string;
      if (save) {
        await click(windowRef, await find(windowRef, selectors.fileTab));
        const fileMenu = await popup();
        await sleep(250);
        dispatched = true;
        await call('ui.click', { windowRef: fileMenu,
          elementRef: await find(fileMenu, selectors.saveAs) });
        host = await popup(profile.save.dialogTitle);
      } else {
        await click(windowRef, await find(windowRef, selectors.brushMenu));
        host = await popup();
      }
      treeCache.delete(host);
      if (!save) {
        phase = 'selectBrush';
        await click(host, await find(host, profile.brushes[a.brush]));
        const brushName = profile.brushes[a.brush].name;
        for (let i = 0; i < 20; i++) {
          const result = await call('ui.find', { windowRef, selector: { role: 'Pane', nameContains: brushName },
            depth: 20, limit: 2, format: 'locator' });
          if (!complete(result)) throw new Error('ui_inspection_incomplete');
          if (result.elements.length === 1) return;
          await sleep(100);
        }
        return;
      }
      phase = 'saveFilename';
      const ref = await find(host, profile.save.fileName);
      const nativePath = a.path.replaceAll('/', '\\');
      await call('ui.set_value', { elementRef: ref, value: nativePath });
      if ((await call('ui.get', { elementRef: ref })).value !== nativePath) throw new Error('filename_readback_mismatch');
      phase = 'saveConfirm';
      await click(host, await find(host, profile.save.confirm));
      for (let i = 0; i < 50; i++) {
        try {
          const bytes = await readFile(a.path);
          if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
        } catch { /* wait */ }
        await sleep(100);
      }
      throw new Error('save_not_completed');
    }
    const s = shape!;
    phase = 'inspect';
    await find(windowRef, selectors.zoom);
    const canvasRef = await find(windowRef, selectors.canvas);
    const canvas = (await call('ui.get', { elementRef: canvasRef, details: false })).bounds;
    const calibration = (await call('ui.get', { elementRef: await find(windowRef, selectors.ellipse), details: false })).bounds;
    const scale = calibration.width / profile.referenceToolSize;
    if (scale < 1 || scale > 2 || Math.abs(calibration.height / profile.referenceToolSize - scale) > .01)
      throw new Error('profile_scale_mismatch');
    const canvasScale = scale * 96 / window.dpi;
    const scaled = (n: number) => Math.round(n * canvasScale), uiScaled = (n: number) => Math.round(n * scale);
    const [x1, y1, x2, y2] = s.box;
    if (scaled(Math.max(x1, x2)) >= canvas.width - 20 || scaled(Math.max(y1, y2)) >= canvas.height - 20)
      throw new Error('shape_outside_visible_canvas');
    const ox = canvas.x - window.bounds.x + uiScaled(profile.canvasInset[0]);
    const oy = canvas.y - window.bounds.y + uiScaled(profile.canvasInset[1]);
    const commitRef = await find(windowRef, selectors.commit);
    const textCommitBounds = s.text ? (await call('ui.get', { elementRef: commitRef, details: false })).bounds : undefined;
    if (state.tool !== s.tool) { state.tool = s.tool; state.values = {}; }
    phase = 'setup';
    if (state.activeTool !== s.tool) {
      if (s.path) {
        await click(windowRef, await find(windowRef, selectors.brushMain));
        treeCache.delete(windowRef);
        await click(windowRef, await find(windowRef, selectors.primary));
        treeCache.delete(windowRef);
      } else await click(windowRef, await find(windowRef, selectors[s.tool]));
      // Selecting a shape enables ribbon controls that were disabled in the discovery tree.
      treeCache.delete(windowRef);
      state.activeTool = s.tool;
    }
    if (!s.path && !s.text && s.fill !== undefined && !equal(state.values.fill, s.fill)) {
      await menu('fill', profile[s.fill ? 'solidFill' : 'noFill']); state.values.fill = s.fill;
    }
    if (s.stroke.width !== undefined && !equal(state.values.width, s.stroke.width)) {
      await menu('width', profile.widthOptions[String(s.stroke.width)]); state.values.width = s.stroke.width;
    }
    if (!s.path && !s.text && (s.stroke.color || s.stroke.width) && !state.values.outline) {
      await menu('outline', profile.solidOutline); state.values.outline = true;
    }
    if (s.stroke.color && !equal(state.values.primary, s.stroke.color)) {
      await setColor('primary', s.stroke.color); state.values.primary = s.stroke.color;
    }
    if (s.fill && !equal(state.values.secondary, s.fill)) {
      await setColor('secondary', s.fill); state.values.secondary = s.fill;
    }
    phase = 'draw';
    const current = await call('window.get', { windowRef });
    if (!equal(current.bounds, window.bounds)) throw new Error('layout_changed_during_setup');
    const vertices = s.vertices;
    let points: number[][];
    if (s.path) {
      points = vertices!.map(p => [ox + scaled(p[0]), oy + scaled(p[1])]);
      if (a.closed && !equal(points[0], points[points.length - 1])) points.push(points[0]);
    } else if (s.polygon) points = vertices!.slice(0, 2).map(p => [ox + scaled(p[0]), oy + scaled(p[1])]);
    else points = [[ox + scaled(x1), oy + scaled(y1)], [ox + scaled(x2), oy + scaled(y2)]];
    dispatched = true;
    await call('input.move', { windowRef, coordinateSpace: 'window_relative', expectedSize: window.bounds,
      points, hold: 'left' });
    if (s.polygon) {
      // Dense clicks can outrun Paint's polygon state transitions and still
      // return successful input receipts while closing an incomplete shape.
      await sleep(profile.polygonClickDelayMs ?? 50);
      for (let i = 2; i < vertices!.length; i++) {
        await call('input.click', { windowRef, coordinateSpace: 'window_relative', expectedSize: window.bounds,
          x: ox + scaled(vertices![i][0]), y: oy + scaled(vertices![i][1]),
          count: i + 1 === vertices!.length ? 2 : 1 });
        await sleep(profile.polygonClickDelayMs ?? 50);
      }
    }
    if (s.text) {
      phase = 'text'; treeCache.delete(windowRef);
      const editor = await find(windowRef, profile.textEditor);
      const filled = await call('ui.fill', { windowRef, elementRef: editor, text: a.text,
        method: 'auto', timeoutMs: 5000 });
      if (filled.verification !== 'passed') throw new Error('text_readback_not_verified');
      await click(windowRef, await find(windowRef, profile.homeTab));
      await sleep(100);
      if (!equal((await call('window.get', { windowRef })).bounds, window.bounds))
        throw new Error('layout_changed_before_text_commit');
      await call('input.click', { windowRef, coordinateSpace: 'window_relative',
        x: textCommitBounds.x + Math.floor(textCommitBounds.width / 2) - window.bounds.x,
        y: textCommitBounds.y + Math.floor(textCommitBounds.height / 2) - window.bounds.y });
    } else if (!s.path) {
      phase = 'commit';
      await call('ui.invoke', { elementRef: commitRef });
    }
    if (!s.path) state.activeTool = undefined;
  };
  for (let i = 0; i < actions.length; i++) {
    try { await perform(actions[i], shapes[i]); completed++; }
    catch (error: any) {
      return { status: 'error', action: actions.length === 1 ? actions[0].action : 'drawing.drawScene', completed, total: actions.length,
        failedIndex: i, phase, dispatch: dispatched ? 'possibly_partial' : 'not_started',
        drawAttempted: dispatched, nativeCalls: calls, message: String(error?.message ?? error), retryable: !dispatched };
    }
  }
  return { status: 'ok', action: actions.length === 1 ? actions[0].action : 'drawing.drawScene', completed, total: actions.length,
    nativeCalls: calls, verification: actions.length === 1 && actions[0].action === 'document.saveAs'
      ? 'action_dispatched' : 'scene_dispatched', dispatch: 'returned' };
}
