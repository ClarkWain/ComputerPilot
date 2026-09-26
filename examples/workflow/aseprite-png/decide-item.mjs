/**
 * Trusted local item policy. The workflow host still owns the Aseprite process,
 * artifact path, journal, and verification. This module can only choose export
 * or skip for each frozen input item.
 */
export default async function decideItem(source) {
  const pathParts = source.relativePath.split(/[\\/]/);
  if (pathParts.some(part => part.toLowerCase() === '_reference')) {
    return { decision: 'skip', reason: 'Reference-only assets are excluded from export.' };
  }

  return { decision: 'export' };
}
