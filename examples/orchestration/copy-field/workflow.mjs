function readUniqueText(state, field) {
  const inspection = state.inspection;
  if (!inspection || inspection.status !== 'ok' || inspection.truncated === true ||
      inspection.has_more === true || inspection.evidenceComplete === false ||
      (inspection.stopReason !== undefined && inspection.stopReason !== 'complete') ||
      inspection.providerError || !Array.isArray(state.controls)) {
    throw new Error('Source inspection is incomplete; no target input was dispatched');
  }
  const matches = state.controls.filter(control => control.name === field.name &&
    control.role === field.role && control.enabled === true && control.offscreen === false);
  if (matches.length !== 1 || typeof matches[0].value !== 'string') {
    throw new Error('Source requires one enabled visible text field with a string value');
  }
  return matches[0].value;
}

export default async function run(ctx) {
  const input = await ctx.readInput('records');
  for (const record of input.records) {
    await ctx.item(record.id, async item => {
      const source = await item.withDesktop('source', desktop =>
        desktop.observe('read', { target: record.source.target }));
      const text = readUniqueText(source, record.source.field);
      if (typeof record.target.beforeValue !== 'string') {
        throw new Error('Target beforeValue must be a string');
      }
      await item.withDesktop('target', desktop => desktop.step('fill', {
        mode: 'batch',
        target: record.target.target,
        actions: [{ type: 'fill_text', control: record.target.field, text }],
        before: { control: { ...record.target.field, value: record.target.beforeValue } },
        expect: { control: { ...record.target.field, value: text } }
      }));
      await item.checkpoint('done', { sourceId: record.id });
    });
  }
}
