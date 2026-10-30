export type NativeCall = (operation: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<any>;
export type Action = { action: string; args?: Record<string, any> };
export type Profile = {
  id: string; schemaVersion: number; dpi: number; supportedDpi?: number[];
  minimumWindowWidth: number; minimumClientSize: { width: number; height: number; unit: string };
  preferredClientSize?: { width: number; height: number; unit: string };
  actions: Array<{ action: string; description?: string; example?: Action }>;
  match: { executable: string; className: string; requiredSelectors: string[]; requiredMenuLabel?: string };
  selectors: Record<string, any>; description: string; coordinates: string;
  adapter?: string; [key: string]: any;
};

export function failed(value: any): boolean {
  return value && typeof value === 'object' &&
    (['error', 'failed', 'timeout', 'partial'].includes(value.status) || value.verification === 'failed');
}
export function complete(value: any): boolean {
  return value && typeof value === 'object' && !failed(value) && Array.isArray(value.elements) &&
    !value.truncated && !value.has_more && value.evidenceComplete !== false &&
    (value.stopReason === undefined || value.stopReason === 'complete');
}
export function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export function int(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Expected integer in ${min}..${max}`);
  return value as number;
}
export function point(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Point requires x and y');
  return [int(value[0], 0, 32000), int(value[1], 0, 32000)];
}
export function rgb(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('RGB requires three channels');
  return value.map(v => int(v, 0, 255));
}
export function keysOnly(value: Record<string, any>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported argument: ${key}`);
}
export async function checked(call: NativeCall, operation: string, args: Record<string, unknown>): Promise<any> {
  const result = await call(operation, args);
  if (failed(result)) throw new Error(`${operation}: ${result.message ?? result.code ?? 'operation_failed'}`);
  return result;
}
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export function selectorMatches(element: any, selector: any): boolean {
  if (element.offscreen || element.enabled === false) return false;
  return Object.entries(selector).every(([key, value]) => key === 'nameContains'
    ? String(element.name ?? '').includes(String(value)) : equal(element[key], value));
}
export async function findUnique(call: NativeCall, windowRef: string, selector: any,
  options: Record<string, unknown> = {}): Promise<any> {
  const result = await checked(call, 'ui.find', { windowRef, selector, depth: 20, limit: 2,
    format: 'locator', ...options });
  if (!complete(result)) throw new Error('ui_inspection_incomplete');
  if (result.elements.length !== 1) throw new Error(`control_not_unique: ${JSON.stringify(selector)}`);
  return result.elements[0];
}
export async function centerClick(call: NativeCall, windowRef: string, elementRef: string): Promise<void> {
  const element = await checked(call, 'ui.get', { elementRef, details: false });
  const window = await checked(call, 'window.get', { windowRef });
  const b = element.bounds, w = window.bounds;
  await checked(call, 'input.click', { windowRef, coordinateSpace: 'window_relative',
    x: b.x + Math.floor(b.width / 2) - w.x, y: b.y + Math.floor(b.height / 2) - w.y });
}
