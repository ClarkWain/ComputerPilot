export default async function run(ctx) {
  const { items } = await ctx.readInput('items');
  for (const item of items) {
    await ctx.item(item.id, async current => {
      const choice = item.needsReview
        ? await current.ask('decision', {
            question: `Include ${item.id}?`,
            choices: ['include', 'skip']
          })
        : 'include';
      await current.checkpoint('reviewed', { itemId: item.id, choice });
    });
  }
}
