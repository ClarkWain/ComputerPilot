import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClassic } from '../adapters/classic-paint.js';
import { runModern } from '../adapters/modern-paint.js';
import { runAseprite, supportedAsepriteActions, inspectAsepriteMenu,
  asepriteSaveGeometrySupported } from '../adapters/aseprite.js';
import { failed, complete, shallow, equal, type NativeCall, type Action, type Profile } from '../adapters/common.js';

export type { NativeCall, Action, Profile } from '../adapters/common.js';
export type DiscoverOptions = { window?: any; tree?: any; signal?: AbortSignal };

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDirectory = [resolve(moduleDirectory, '../../../profiles'),
  resolve(moduleDirectory, '../../../../profiles')].find(existsSync) ?? resolve(moduleDirectory, '../../../profiles');
const nextByReason: Record<string, string> = {
  ui_inspection_incomplete: 'Compatibility is unknown because control inspection was incomplete; inspect the image and use execute_batch when the target is visually clear. No drawing was dispatched.',
  dpi_mismatch: 'DPI unsupported by this profile; resizing cannot fix DPI.',
  window_blocked: 'Target has a modal dialog; resolve it before drawing.',
  toolbar_too_narrow: 'Toolbar is too narrow at this DPI; explicitly prepare the window, then inspect again.',
  client_area_unknown: 'Physical client area or display DPI could not be measured.',
  insufficient_client_area: 'Client area is smaller than this profile requires; explicitly prepare the window, then inspect again.',
  visual_menu_not_confirmed: 'Profile menu language or visual evidence could not be confirmed; inspect the image and use basic actions.'
};

export function profileSupportsDpi(profile: Profile, dpi: number): boolean {
  return Array.isArray(profile.supportedDpi) ? profile.supportedDpi.includes(dpi) : profile.dpi === dpi;
}

export function profileGeometryIssue(profile: Profile, window: any): string {
  if (profile.schemaVersion === 2) {
    const client = window?.client;
    if (!client?.dip96) return 'client_area_unknown';
    const min = profile.minimumClientSize;
    if (client.physical && window?.display?.dpi) {
      const dpi = window.display.dpi;
      if (dpi <= 0) return 'client_area_unknown';
      return client.physical.width < Math.round(min.width * dpi / 96) ||
        client.physical.height < Math.round(min.height * dpi / 96)
        ? 'insufficient_client_area' : '';
    }
    return client.dip96.width < min.width || client.dip96.height < min.height ? 'insufficient_client_area' : '';
  }
  const dpi = window?.display?.dpi ?? window?.dpi ?? 96;
  return window?.bounds?.width < profile.minimumWindowWidth * (dpi > 0 ? dpi : 96) / 96 ? 'toolbar_too_narrow' : '';
}

function matches(element: any, selector: any): boolean {
  if (element.offscreen || element.enabled === false) return false;
  return Object.entries(selector).every(([key, value]) => key === 'nameContains'
    ? String(element.name ?? '').includes(String(value)) : equal(element[key], value));
}

function logicalKey(element: any): string {
  const b = element.bounds;
  return [element.role ?? '', element.name ?? '', element.automationId ?? '',
    b ? `${b.x ?? 0},${b.y ?? 0},${b.width ?? 0},${b.height ?? 0}` : ''].join('\n');
}

export class ProfileEngine {
  readonly nativeCall: NativeCall;
  readonly profilesDir: string;
  constructor(nativeCall: NativeCall, profilesDir = process.env.DESKTOPPILOT_PROFILES_DIR || defaultDirectory) {
    this.nativeCall = nativeCall;
    this.profilesDir = profilesDir;
  }

  async load(id: string): Promise<Profile> {
    if (!/^[A-Za-z0-9_.-]+$/.test(id) || id === '.' || id === '..')
      throw new Error('profile must be an installed profile id returned by get_window_state');
    const p = JSON.parse(await readFile(join(this.profilesDir, id, 'profile.json'), 'utf8')) as Profile;
    if (p.id !== id || !Array.isArray(p.actions) || ![1, 2].includes(p.schemaVersion))
      throw new Error(`Invalid profile manifest: ${id}`);
    if (p.schemaVersion === 2) {
      for (const key of ['minimumClientSize', 'preferredClientSize'] as const) {
        const size = p[key];
        if (key === 'preferredClientSize' && !size) continue;
        if (!size || size.unit !== 'dip96' || !Number.isInteger(size.width) || !Number.isInteger(size.height) ||
          size.width <= 0 || size.height <= 0 || size.width > 20000 || size.height > 20000)
          throw new Error(`Invalid client size: ${id}`);
      }
      if (p.preferredClientSize && (p.preferredClientSize.width < p.minimumClientSize.width ||
        p.preferredClientSize.height < p.minimumClientSize.height))
        throw new Error(`Preferred client size is smaller than minimum: ${id}`);
    }
    return p;
  }

  async discover(windowRef: string, options: DiscoverOptions = {}): Promise<any> {
    const call = (op: string, args: Record<string, unknown>) => {
      if (options.signal?.aborted) throw new Error('request_cancelled');
      return this.nativeCall(op, args, { signal: options.signal });
    };
    const window = options.window ?? await call('window.get', { windowRef });
    if (failed(window)) return window;
    const profiles: any[] = [], unavailable: any[] = [];
    let directories: string[];
    try { directories = (await readdir(this.profilesDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
    catch (error: any) {
      if (error?.code === 'ENOENT') return { status: 'ok', profiles, unavailable, reason: 'profiles_directory_missing' };
      throw error;
    }
    let tree = options.tree;
    for (const id of directories) {
      if (options.signal?.aborted) throw new Error('request_cancelled');
      try {
        const profile = await this.load(id), match = profile.match;
        if (String(window.executable ?? '').toLowerCase() !== String(match.executable).toLowerCase()) continue;
        const reasons: string[] = [];
        if (window.className !== match.className) reasons.push('window_class_mismatch');
        if (!profileSupportsDpi(profile, window.dpi)) reasons.push('dpi_mismatch');
        const issue = profileGeometryIssue(profile, window);
        if (issue) reasons.push(issue);
        if (window.enabled === false) reasons.push('window_blocked');
        if (window.minimized === true) reasons.push('window_minimized');
        if (!reasons.length) {
          if (tree === undefined) {
            try { tree = await call('ui.tree', { windowRef, format: 'locator', depth: 16,
              limit: 400, nodeBudget: 3000, queryTimeoutMs: 5000, metrics: true }); }
            catch (error: any) {
              if (options.signal?.aborted) throw error;
              tree = { status: 'error', code: 'ui_inspection_failed',
              message: String(error?.message ?? error), stopReason: 'provider_error', evidenceComplete: false }; }
          }
          if (!complete(tree) && !shallow(tree)) reasons.push('ui_inspection_incomplete');
          else for (const name of match.requiredSelectors) {
            const selector = profile.selectors[name];
            const found = tree.elements.filter((e: any) => matches(e, selector));
            if ((shallow(tree) ? new Set(found.map(logicalKey)).size === 0 : found.length !== 1))
              reasons.push(`control_not_unique:${name}`);
          }
          if (!reasons.length && typeof match.requiredMenuLabel === 'string') {
            try { await inspectAsepriteMenu(call, windowRef, profile, window, match.requiredMenuLabel); }
            catch (error: any) { if (options.signal?.aborted) throw error;
              reasons.push('visual_menu_not_confirmed');
              tree = { ...tree, visualMenuError: String(error?.message ?? error) }; }
          }
        }
        if (!reasons.length) profiles.push({ id, description: profile.description,
          coordinates: profile.coordinates, actions: profile.adapter === 'aseprite-vision'
            ? profile.actions.filter(a => supportedAsepriteActions.has(a.action) &&
              (a.action !== 'aseprite.saveAsDefault' || asepriteSaveGeometrySupported(profile, window))) : profile.actions });
        else {
          const reason = reasons.find(value => nextByReason[value]);
          const item: any = { id, reasons, actual: { dpi: window.dpi ?? 0, width: window.bounds?.width },
            next: reason ? nextByReason[reason] : 'Required controls are missing or ambiguous; inspect the layout and app version.' };
          for (const field of ['recommendedWindow', 'preferredClientSize', 'minimumClientSize'] as const)
            if (profile[field] !== undefined) item[field] = profile[field];
          if (window.client?.dip96) item.actualClientSize = window.client.dip96;
          if (tree !== undefined) {
            item.inspection = {};
            for (const key of ['stopReason', 'visited', 'truncated', 'has_more', 'evidenceComplete', 'message', 'code', 'providerError', 'metrics', 'visualMenuError'])
              if (tree[key] !== undefined) item.inspection[key] = tree[key];
          }
          unavailable.push(item);
        }
      } catch (error: any) {
        if (options.signal?.aborted) throw error;
        unavailable.push({ id, reasons: [`profile_error: ${String(error?.message ?? error)}`] });
      }
    }
    return { status: 'ok', profiles, unavailable, ...(tree !== undefined ? { inspection: tree } : {}) };
  }

  async execute(windowRef: string, profileId: string | undefined, actions: Action[],
    options: { signal?: AbortSignal } = {}): Promise<any> {
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 256)
      throw new Error('actions must contain 1..256 items');
    const call: NativeCall = (op, args) => {
      if (options.signal?.aborted) throw new Error('request_cancelled');
      return this.nativeCall(op, args, { signal: options.signal });
    };
    const startSession = await call('system.session', {});
    if (failed(startSession) || !startSession.inputDesktopAccessible || startSession.lockState === 'locked')
      return { status: 'error', code: 'interactive_desktop_unavailable', dispatch: 'not_started', completed: 0 };
    const window = await call('window.get', { windowRef });
    if (failed(window)) return window;
    const catalog = await this.discover(windowRef, { window, signal: options.signal });
    if (failed(catalog)) return catalog;
    const candidates: any[] = catalog.profiles;
    const chosen = profileId || (candidates.length === 1 ? candidates[0].id : '');
    const compatible = candidates.some(p => p.id === chosen);
    const incomplete = catalog.unavailable.some((p: any) => (!chosen || p.id === chosen) &&
      p.reasons.includes('ui_inspection_incomplete'));
    if (!compatible) return { status: 'error',
      code: !chosen && candidates.length > 1 ? 'profile_ambiguous' : incomplete ? 'profile_inspection_incomplete' : 'profile_not_matched',
      dispatch: 'not_started', completed: 0,
      semantic: { status: catalog.status, profiles: catalog.profiles, unavailable: catalog.unavailable },
      next: incomplete ? 'Compatibility is unknown; inspect using get_window_state(mode=image), then use execute_batch when visually clear. Do not repeat unchanged scans.'
        : candidates.length === 0 ? 'No matching profile: use execute_batch or correct the reported app conditions.'
          : 'Choose one of the returned compatible profile ids.' };
    const profile = await this.load(chosen);
    const exposedActions: Array<{ action: string }> = candidates.find(candidate => candidate.id === chosen)?.actions ?? [];
    for (const item of actions) if (!exposedActions.some(a => a.action === item?.action))
      return { status: 'error', code: 'action_not_supported', action: item?.action,
        dispatch: 'not_started', completed: 0, next: 'Use an action example returned by get_window_state for this profile.' };
    const currentSession = await call('system.session', {});
    const currentWindow = await call('window.get', { windowRef });
    const fields = ['windowRef', 'pid', 'dpi', 'bounds', 'className', 'executable', 'enabled', 'minimized', 'foreground',
      'client', 'display', 'dpiAwareness'];
    const staleFields = fields.filter(key => (window[key] !== undefined || currentWindow[key] !== undefined) &&
      !equal(window[key], currentWindow[key]));
    if (failed(currentSession) || failed(currentWindow) || !currentSession.inputDesktopAccessible ||
      currentSession.lockState === 'locked') staleFields.push('desktop');
    if (startSession.lastInputTick === undefined || currentSession.lastInputTick === undefined ||
      !equal(startSession.lastInputTick, currentSession.lastInputTick)) staleFields.push('lastInputTick');
    if (staleFields.length) return { status: 'error', code: 'profile_evidence_stale', dispatch: 'not_started',
      completed: 0, staleFields, next: 'Observe the window again before executing semantic actions.' };
    let result: any;
    if (profile.adapter === 'paint-modern') result = await runModern(call, windowRef, profile, actions);
    else if (profile.adapter === 'aseprite-vision') result = await runAseprite(call, windowRef, profile, actions);
    else if (!profile.adapter) result = await runClassic(call, windowRef, profile, actions, catalog.inspection);
    else result = { status: 'error', code: 'unsupported_semantic_adapter', dispatch: 'not_started', completed: 0 };
    return { ...result, profile: chosen, next: 'get_window_state to verify the visible result; do not replay completed actions.' };
  }
}
