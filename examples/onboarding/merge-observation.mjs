// JSON state only. Patch images keep capture.rect/frame; this does not composite pixels.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function applyPatch(value, patch) {
  if (!object(patch) || (patch.set !== undefined && !object(patch.set)) ||
      (patch.unset !== undefined && (!Array.isArray(patch.unset) || patch.unset.some(key => typeof key !== 'string'))))
    throw new Error('Invalid state patch; request a full observation');
  const result = { ...value, ...patch.set };
  for (const key of patch.unset ?? []) delete result[key];
  return result;
}

export function mergeObservation(previous, response) {
  if (!object(response) || response.status !== 'ok' || typeof response.window_id !== 'string')
    throw new Error('Observation failed; discard the baseline and observe again');
  const incoming = structuredClone(response);
  const kind = incoming.change?.kind;
  if (kind === undefined || kind === 'full') return incoming;
  if (!previous || previous.window_id !== incoming.window_id || !['delta', 'unchanged'].includes(kind))
    throw new Error('Missing or mismatched baseline; request a full observation');
  let result = structuredClone(previous);
  if (kind === 'unchanged') return { ...result, change: incoming.change };
  if (incoming.window) result = applyPatch(result, incoming.window);
  if (incoming.controls) {
    if (!Array.isArray(result.controls) || !object(incoming.controls))
      throw new Error('Missing controls baseline; request a full observation');
    const controls = new Map(result.controls.map(control => [control.control_id, control]));
    for (const id of incoming.controls.removed ?? []) {
      if (!controls.delete(id)) throw new Error('Unknown removed control; request a full observation');
    }
    for (const update of incoming.controls.updated ?? []) {
      if (!controls.has(update.control_id)) throw new Error('Unknown updated control; request a full observation');
      controls.set(update.control_id, applyPatch(controls.get(update.control_id), update));
    }
    for (const control of incoming.controls.added ?? []) {
      if (typeof control.control_id !== 'string' || controls.has(control.control_id))
        throw new Error('Invalid added control; request a full observation');
      controls.set(control.control_id, control);
    }
    result.controls = [...controls.values()];
  }
  for (const key of ['semantic', 'inspection', 'truncated', 'capture'])
    if (key in incoming) result[key] = incoming[key];
  return { ...result, change: incoming.change };
}
