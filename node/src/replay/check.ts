import { ProfileEngine, type Profile } from '../profiles/engine.js';
import { supportedAsepriteActions } from '../adapters/aseprite.js';
import type { ReplayRecipe } from './recipe.js';

// Capability names only: argument and live-window validation remain with the adapters.
const classicActions = new Set(['drawing.selectBrush', 'document.saveAs', 'document.setCanvasSize',
  'drawing.drawCircle', 'drawing.drawEllipse', 'drawing.drawRectangle', 'drawing.drawRoundedRectangle',
  'drawing.drawLine', 'drawing.drawPolyline', 'drawing.drawPolygon', 'drawing.drawText']);
const modernActions = new Set(['drawing.selectBrush', 'drawing.setColor', 'drawing.setStrokeWidth',
  'drawing.fillAt', 'drawing.drawPolyline']);

export type ReplayCheckIssue = { step: string; profile: string; action?: string; actionIndex?: number;
  code: 'unknown_profile' | 'invalid_profile' | 'unsupported_adapter' | 'unknown_action' | 'unsupported_action';
  message: string };

function checkDiscoveryStructure(profile: Profile): void {
  const object = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
  const match = profile.match;
  if (!object(match) || !text(match.executable) || !text(match.className) ||
    !Array.isArray(match.requiredSelectors) || !object(profile.selectors) ||
    match.requiredSelectors.some((name: unknown) => !text(name) ||
      !Object.hasOwn(profile.selectors, name) || !object(profile.selectors[name]) ||
      !Object.keys(profile.selectors[name]).length) ||
    (match.requiredMenuLabel !== undefined && !text(match.requiredMenuLabel)) ||
    (profile.adapter !== undefined && !text(profile.adapter)) ||
    profile.actions.some(action => !object(action) || !text(action.action)))
    throw new Error(`Invalid profile discovery structure: ${profile.id}`);
}

/** Call only after loadRecipe and assetBytes have validated the recipe and resources. */
export async function checkRecipe(recipe: ReplayRecipe, profilesDirectory = process.env.DP_PROFILES_DIR) {
  const engine = new ProfileEngine(async () => { throw new Error('Offline check cannot call the worker'); },
    profilesDirectory);
  const issues: ReplayCheckIssue[] = [];
  let knownProfiles = true, knownActions = true;
  for (const step of recipe.steps) {
    let profile: Profile;
    try { profile = await engine.load(step.profile); checkDiscoveryStructure(profile); }
    catch (error: any) {
      knownProfiles = false;
      knownActions = false;
      issues.push({ step: step.id, profile: step.profile,
        code: error?.code === 'ENOENT' ? 'unknown_profile' : 'invalid_profile',
        message: String(error?.message ?? error) });
      continue;
    }
    const supported = profile.adapter === 'paint-modern' ? modernActions
      : profile.adapter === 'aseprite-vision' ? supportedAsepriteActions
        : !profile.adapter ? classicActions : undefined;
    if (!supported) issues.push({ step: step.id, profile: step.profile, code: 'unsupported_adapter',
      message: `Node does not implement adapter: ${profile.adapter}` });
    for (const [actionIndex, action] of (step.actions ?? [step.action!]).entries()) {
      const declared = profile.actions.some(item => item?.action === action.action);
      if (!declared || !supported?.has(action.action)) {
        knownActions = false;
        issues.push({ step: step.id, profile: step.profile, action: action.action, actionIndex,
          code: declared ? 'unsupported_action' : 'unknown_action',
          message: declared ? 'Installed action is not implemented by this Node adapter'
            : 'Action is not declared by the installed profile' });
      }
    }
  }
  return { formatValid: true, knownProfiles, knownActions, compatible: issues.length === 0,
    environmentChecked: false, parametersChecked: false, profilesDirectory: engine.profilesDir,
    issues };
}
