import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checked, int, keysOnly, sleep, type Action, type NativeCall, type Profile } from './common.js';

const toolHotkeys: Record<string, string> = {
  pencil: 'B', spray: 'N', eraser: 'E', paintBucket: 'G', line: 'L', rectangle: 'U',
  ellipse: 'O', text: 'T', magicWand: 'W', hand: 'H', eyedropper: 'Y', move: 'M',
  rectangularMarquee: 'F'
};
const zoomHotkeys: Record<number, string> = { 100: '1', 200: '2', 400: '3', 800: '4', 1600: '5', 3200: '6' };
export const supportedAsepriteActions = new Set([
  'aseprite.keyChord', 'aseprite.selectTool', 'aseprite.zoom', 'aseprite.click',
  'aseprite.openMenu', 'aseprite.saveAsDefault'
]);
const menuNames = new Set(['File', 'Edit', 'Sprite', 'Layer', 'Frame', 'Select', 'Tags', 'View', 'Help']);

export function asepriteSaveGeometrySupported(profile: Profile, host: any): boolean {
  const reference = profile.saveDialogWindowSize ?? { width: 2578, height: 1398 };
  return host?.dpi === (profile.saveDialogDpi ?? 96) &&
    Math.abs(host?.bounds?.width - reference.width) <= 20 &&
    Math.abs(host?.bounds?.height - reference.height) <= 20;
}

class MenuInspectionError extends Error {
  constructor(readonly phase: 'capture' | 'ocr', message: string) { super(message); }
}

function ocrModels(profile: Profile): string {
  if (typeof profile.ocrModels === 'string') return profile.ocrModels;
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.DESKTOPPILOT_OCR_MODELS,
    resolve(moduleDirectory, '../../../models/ocr'), resolve(moduleDirectory, '../../../../models/ocr')];
  const found = candidates.find(path => path && existsSync(join(path, 'det.onnx')) && existsSync(join(path, 'rec.onnx')));
  if (!found) throw new Error('ocr_models_unavailable: det.onnx and rec.onnx are required');
  return found;
}

function matchingMenuLine(lines: any[], target: string): { x: number; y: number; score: number } | undefined {
  const needle = target.toLowerCase();
  let best: { x: number; y: number; score: number } | undefined;
  for (const line of lines) {
    const text = String(line.text ?? ''), lower = text.toLowerCase();
    const pos = lower.indexOf(needle);
    if (pos < 0 || (pos > 0 && /[a-z]/i.test(text[pos - 1])) ||
      (pos + needle.length < text.length && /[a-z]/i.test(text[pos + needle.length]))) continue;
    const b = line.bounds, score = Number(line.recognitionScore ?? 0);
    if (!b || !Number.isFinite(score) || (best && score <= best.score)) continue;
    const fraction = (pos + target.length / 2) / Math.max(text.length, 1);
    best = { x: b.x + Math.round(b.width * fraction), y: b.y + Math.floor(b.height / 2), score };
  }
  return best;
}

/** Read-only English menu evidence; callers decide whether to click. */
export async function inspectAsepriteMenu(call: NativeCall, windowRef: string, profile: Profile,
  host: any, name: string): Promise<{ x: number; y: number; score: number }> {
  const bounds = host.bounds;
  const height = Math.round((profile.menuBarHeightPx ?? 30) * host.dpi / 96);
  if (height <= 0 || height > bounds.height / 2) throw new MenuInspectionError('capture', 'menu_bar_height_out_of_range');
  const output = join(tmpdir(), `desktop-pilot-aseprite-menu-${randomUUID()}.png`);
  let ocr: any;
  let phase: 'capture' | 'ocr' = 'capture';
  try {
    const strip = await checked(call, 'capture.region', { x: bounds.x, y: bounds.y,
      width: bounds.width, height, output, method: 'screen' });
    phase = 'ocr';
    ocr = await checked(call, 'vision.ocr', { image: strip.path, ocrModels: ocrModels(profile),
      ocrMaxSide: profile.ocrMaxSide ?? 2048 });
  } catch (error) {
    throw new MenuInspectionError(phase, error instanceof Error ? error.message : String(error));
  } finally { await unlink(output).catch(() => {}); }
  const best = matchingMenuLine(ocr.textLines ?? [], name);
  if (!best) throw new MenuInspectionError('ocr', `menu_label_not_found: ${name}`);
  if (best.score < (profile.ocrMinScore ?? 0.4)) throw new MenuInspectionError('ocr', 'menu_label_score_below_threshold');
  if (best.x < 0 || best.y < 0 || best.x >= bounds.width || best.y >= height)
    throw new MenuInspectionError('ocr', 'menu_label_outside_strip');
  return best;
}
function validate(item: Action): void {
  const a = item.args ?? {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('args must be an object');
  if (item.action === 'aseprite.keyChord') {
    keysOnly(a, ['keys']);
    if (!Array.isArray(a.keys) || a.keys.length < 1 || a.keys.length > 8 ||
      a.keys.some((key: any) => typeof key !== 'string' || !/^(CTRL|SHIFT|ALT|WIN|ENTER|TAB|ESC|BACKSPACE|DELETE|LEFT|RIGHT|UP|DOWN|HOME|END|SPACE|PAGEUP|PAGEDOWN|INSERT|[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key)))
      throw new Error('Unsupported key; use uppercase key names');
  } else if (item.action === 'aseprite.selectTool') {
    keysOnly(a, ['tool']);
    if (!(a.tool in toolHotkeys)) throw new Error('Unknown tool');
  } else if (item.action === 'aseprite.zoom') {
    keysOnly(a, ['percent']);
    if (!(int(a.percent, 100, 3200) in zoomHotkeys)) throw new Error('Unsupported zoom');
  } else if (item.action === 'aseprite.click') {
    keysOnly(a, ['x', 'y', 'button', 'count']);
    int(a.x, 0, 32000); int(a.y, 0, 32000);
    if (a.button !== undefined && !['left', 'right', 'middle'].includes(a.button)) throw new Error('Invalid button');
    if (a.count !== undefined) int(a.count, 1, 3);
  } else if (item.action === 'aseprite.openMenu') {
    keysOnly(a, ['name']);
    if (!menuNames.has(a.name)) throw new Error('Unknown menu; use File/Edit/Sprite/Layer/Frame/Select/Tags/View/Help');
  } else if (item.action === 'aseprite.saveAsDefault') {
    keysOnly(a, []);
  } else throw new Error('Unsupported Aseprite action');
}

export async function runAseprite(nativeCall: NativeCall, windowRef: string, profile: Profile,
  actions: Action[]): Promise<any> {
  try { actions.forEach(validate); }
  catch (error: any) { return { status: 'error', code: 'invalid_semantic_args', dispatch: 'not_started',
    completed: 0, message: String(error?.message ?? error) }; }
  let calls = 0, completed = 0, phase = 'preflight', dispatched = false;
  let lastResult: any;
  const call = async (op: string, args: Record<string, unknown>) => { calls++; return checked(nativeCall, op, args); };
  const openMenu = async (host: any, name: string): Promise<any> => {
    phase = 'capture';
    let best;
    try { best = await inspectAsepriteMenu(call, windowRef, profile, host, name); }
    catch (error) { if (error instanceof MenuInspectionError) phase = error.phase; throw error; }
    phase = 'click';
    dispatched = true;
    await call('input.click', { windowRef, coordinateSpace: 'window_relative',
      expectedSize: host.bounds, x: best.x, y: best.y });
    if (profile.menuSettleMs) await sleep(profile.menuSettleMs);
    return { action: 'aseprite.openMenu', menu: name, ocrScore: best.score,
      clickPoint: { x: best.x, y: best.y }, verification: 'ocr_match_and_click_dispatched' };
  };
  try {
    for (const item of actions) {
      const session = await call('system.session', {});
      if (!session.inputDesktopAccessible || session.lockState === 'locked') throw new Error('interactive_desktop_unavailable');
      const host = await call('window.get', { windowRef });
      if (!host.enabled || host.minimized) throw new Error('unsupported_window_state');
      if (!host.foreground) await call('window.activate', { windowRef });
      phase = 'dispatch';
      const a = item.args ?? {};
      if (item.action === 'aseprite.click') {
        if (a.x >= host.bounds.width || a.y >= host.bounds.height) throw new Error('click_point_outside_window');
        dispatched = true;
        await call('input.click', { windowRef, coordinateSpace: 'window_relative', expectedSize: host.bounds,
          x: a.x, y: a.y, ...(a.button ? { button: a.button } : {}), ...(a.count ? { count: a.count } : {}) });
        if (profile.clickSettleMs) await sleep(profile.clickSettleMs);
        lastResult = { action: item.action, x: a.x, y: a.y, verification: 'not_requested' };
      } else if (item.action === 'aseprite.openMenu') {
        lastResult = await openMenu(host, a.name);
      } else if (item.action === 'aseprite.saveAsDefault') {
        // The legacy Allegro dialog uses fixed profile coordinates. Restrict them
        // to the window geometry they were recorded against.
        if (!asepriteSaveGeometrySupported(profile, host))
          throw new Error('save_dialog_window_size_mismatch');
        phase = 'openMenu';
        await openMenu(host, 'File');
        await sleep(400);
        const saveX = profile.saveAsMenuItemX ?? 79, saveY = profile.saveAsMenuItemY ?? 208;
        const okX = profile.saveDialogOkX ?? 2237, okY = profile.saveDialogOkY ?? 1298;
        if ([saveX, okX].some(x => x < 0 || x >= host.bounds.width) ||
          [saveY, okY].some(y => y < 0 || y >= host.bounds.height))
          throw new Error('save_dialog_coordinates_outside_window');
        phase = 'clickSaveAs';
        await call('input.click', { windowRef, coordinateSpace: 'window_relative',
          expectedSize: host.bounds, x: saveX, y: saveY });
        await sleep(800);
        phase = 'clickOk';
        await call('input.click', { windowRef, coordinateSpace: 'window_relative',
          expectedSize: host.bounds, x: okX, y: okY });
        await sleep(700);
        phase = 'checkOverwrite';
        const output = join(tmpdir(), `desktop-pilot-aseprite-overwrite-${randomUUID()}.png`);
        let overwriteCheck = 'unverified';
        let warningUnconfirmed = false;
        try {
          const shot = await call('capture.window', { windowRef, output, method: 'screen' });
          const ocr = await call('vision.ocr', { image: shot.path, ocrModels: ocrModels(profile),
            ocrMaxSide: profile.ocrMaxSide ?? 2048 });
          const lines = ocr.textLines ?? [];
          const sawWarning = lines.some((line: any) => /overwrite|warning|file exists/i.test(String(line.text ?? '')));
          const yes = lines.find((line: any) => String(line.text ?? '').toLowerCase() === 'yes');
          if (sawWarning && yes && Number(yes.recognitionScore ?? 0) >= (profile.ocrMinScore ?? 0.4)) {
            const b = yes.bounds, x = b.x + Math.floor(b.width / 2), y = b.y + Math.floor(b.height / 2);
            if (x < 0 || y < 0 || x >= host.bounds.width || y >= host.bounds.height)
              throw new Error('overwrite_confirmation_outside_window');
            phase = 'clickYes';
            await call('input.click', { windowRef, coordinateSpace: 'window_relative',
              expectedSize: host.bounds, x, y });
            await sleep(400);
            overwriteCheck = 'confirmation_dispatched';
          } else if (sawWarning) { overwriteCheck = 'warning_unconfirmed'; warningUnconfirmed = true; }
          else overwriteCheck = 'no_warning_detected';
        } catch (error) {
          overwriteCheck = `failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally { await unlink(output).catch(() => {}); }
        if (warningUnconfirmed) throw new Error('overwrite_confirmation_missing');
        lastResult = { action: item.action, note: "saved to Aseprite's last-used folder with default filename",
          verification: 'not_requested', overwriteCheck };
      } else {
        const keys = item.action === 'aseprite.keyChord' ? a.keys :
          [item.action === 'aseprite.selectTool' ? toolHotkeys[a.tool] : zoomHotkeys[a.percent]];
        dispatched = true;
        await call('input.key_chord', { windowRef, keys });
        if (profile.keySettleMs) await sleep(profile.keySettleMs);
        lastResult = { action: item.action, verification: 'not_requested' };
      }
      completed++;
    }
    return { status: 'ok', completed, total: actions.length, nativeCalls: calls,
      verification: lastResult?.verification ?? 'not_requested', dispatch: 'returned', lastResult };
  } catch (error: any) {
    return { status: 'error', phase, completed, total: actions.length, failedIndex: completed,
      dispatch: dispatched ? 'possibly_partial' : 'not_started', nativeCalls: calls,
      message: String(error?.message ?? error), retryable: !dispatched };
  }
}
