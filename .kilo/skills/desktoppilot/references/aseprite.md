# Aseprite: verified pixel drawing with current native operations

There is **no built-in `aseprite.drawPixels`, `newCanvas` or `setColor` action yet**. Do not call proposed interfaces. Use documented DesktopPilot input/batch operations and a per-run pixel plan. This procedure was informed by a 32脳32 cold-start UI drawing; it is not an Aseprite-version-independent adapter.

## Before drawing

1. Require the automatic startup desktop preflight to be ready. Select Aseprite uniquely; inspect its current document, dialogs and bounds. Do not change window size or overwrite an unsaved artwork.
2. Plan a new document if needed. Observe the New Sprite dialog, replace width and height separately, and verify the created dimensions before drawing. A previous zero-delay sequence left an old height of 447 instead of 32. Use a bounded state check, or a short transition delay followed by inspection when no readable field exists.
3. Select a 1-pixel pencil. Verify brush size, opacity, foreground color, layer and selection state. The zoom percentage is not necessarily the physical pixel scale on a HiDPI screen.
4. Observe the actual canvas content origin and scale. Logical `(x,y)` maps to its pixel center: `origin + (pixel + 0.5) * physicalScale`. Borders are not content. Recalculate after scrolling, zooming, panel changes or window movement.

## Make a pixel plan, not hundreds of improvised clicks

For a gridded reference, count the cells and transcribe rows using a small palette. Ignore editor chrome and guide lines unless requested. First compare the silhouette, feature placement and negative space; add color only after the plan is coherent. Don't approximate a small pixel reference using arbitrary polygons.

Group final pixels by color. Merge consecutive cells in each row into one horizontal pencil drag; isolated cells use clicks. Set a color once per group. Verify each setter before a large group, and invalidate cached state after failures or dialogs. Don't set color/tool/fill for every dot.

Aseprite color controls can be custom UI: `type_text` dispatch did not reliably update the hex field in the observed version. Inspect the current popup. Try verified field replacement; if unsupported, use its observed RGB sliders or palette and check the resulting value/test pixel. Don't hardcode popup coordinates from this document or earlier sessions. Label approximate colors honestly.

## Execution and acceptance

Batch stable strokes with execute_batch using the observed window_id (geometry checks are internal); stop at UI transitions. Avoid repeated screenshots per stroke. A failed partial batch is not atomic: inspect and resume only unfinished strokes. Preserve requested no-save/no-resize constraints.

There are two different checks:

- **Execution:** screenshot pixel centers match the intended row/palette plan; inspect clipped edges and accidental marks. A zero-difference result here only proves the plan was executed.
- **Artwork:** compare the result to the user's reference for shape, expression, spacing, color and overall readability. This is not implied by the execution check. A faithful plan must be assessed independently.

Leave the document open when no save was requested. Never report a saved file unless its creation was verified.
