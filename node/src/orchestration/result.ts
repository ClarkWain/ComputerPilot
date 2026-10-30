import type { ReplayCondition } from '../replay/recipe.js';
import type { CommandRequest } from './types.js';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(field: string): never { throw new Error(`Invalid desktop reconciliation result: ${field}`); }

/** Checks the recorded value's contract, not the user's claimed on-screen evidence. */
export function validateDesktopReconciliation(request: CommandRequest, value: unknown): void {
  if (!['observe','waitFor','step'].includes(request.kind)) return;
  if (!object(value) || typeof value.title !== 'string') fail('title must be a string');
  if (request.kind === 'step') {
    if (value.status !== 'verified') fail('step.status must be verified');
    const expect = (request.args as { expect: ReplayCondition }).expect;
    const evidence = expect.file?.sha256 ? ['file_hash_checked'] : expect.file ?
      ['file_checked','file_hash_checked'] : expect.control ? ['control_checked'] : ['condition_checked'];
    if (typeof value.verification !== 'string' || !evidence.includes(value.verification))
      fail(`step.verification must be ${evidence.join(' or ')} for the recorded expect`);
    return;
  }
  if (!Array.isArray(value.controls)) fail('controls must be an array');
  for (const control of value.controls) {
    if (!object(control) || typeof control.name !== 'string' || typeof control.role !== 'string')
      fail('each control requires string name and role');
    if ('value' in control && typeof control.value !== 'string') fail('control.value must be a string');
    for (const field of ['enabled','offscreen'])
      if (field in control && typeof control[field] !== 'boolean') fail(`control.${field} must be boolean`);
  }
  if (value.inspection === undefined || value.inspection === null) return;
  const inspection = value.inspection;
  if (!object(inspection) || typeof inspection.status !== 'string' ||
      !['ok','incomplete','error'].includes(inspection.status))
    fail('inspection.status must be ok, incomplete or error');
  for (const field of ['truncated','has_more','evidenceComplete'])
    if (field in inspection && typeof inspection[field] !== 'boolean') fail(`inspection.${field} must be boolean`);
  for (const field of ['stopReason','message','code'])
    if (field in inspection && typeof inspection[field] !== 'string') fail(`inspection.${field} must be a string`);
  if ('visited' in inspection && (!Number.isInteger(inspection.visited) || Number(inspection.visited) < 0))
    fail('inspection.visited must be a nonnegative integer');
  if ('metrics' in inspection && (!object(inspection.metrics) || Object.values(inspection.metrics).some(metric =>
      typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0)))
    fail('inspection.metrics must contain nonnegative numbers');
  if ('providerError' in inspection && typeof inspection.providerError !== 'string' &&
      (!object(inspection.providerError) || typeof inspection.providerError.stage !== 'string' ||
        typeof inspection.providerError.message !== 'string'))
    fail('inspection.providerError must be text or an object with string stage and message');
}
