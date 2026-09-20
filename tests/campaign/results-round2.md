# DesktopPilot — Round 2 Execution Results

Executor: subagents (Claude) via the four MCP tools; lead monitors + fixes. Complements
`results.md` (round 1). Image budget note: Claude hosts cap at **20 images per request**, so
subagents must verify via `mode:"controls"` and use `mode:"image"/"both"` sparingly.

## Batch 11 — File Explorer / 资源管理器 (R01–R10): PASS with hazards
Executed reusing an existing Explorer window; only a self-created `%TEMP%\dp-r2-*` folder was
created/renamed/deleted. Used just **1** screenshot (well under the cap).

What worked:
- Address bar and search box are **reliable named controls** (`地址: …`, search `Edit` with value).
- Create (`Ctrl+Shift+N`), rename (`F2`), search (`Ctrl+E`), navigate (`Ctrl+L`) all worked via keyboard.
- Context-menu **reading** works: the popup enumerated (`删除(D)`, `重命名(M)`, `属性(R)`, …) with `evidenceComplete:true`.
- Delete-to-Recycle-Bin worked; cleanup verified.

Hazards / findings (reliability surface for Computer-Use):
1. **Stale search-results view (false persistence).** After a folder was deleted, the `search-ms`
   results view still listed it (`"1 个项目"`) even after F5; controls reported it as existing.
   Ground truth only came from a `位置不可用` dialog and a changed-query search. → Guidance:
   verify file existence by navigating to the real folder, not a search/virtual view.
2. **Large-folder controls truncation.** In a 1,689-item folder the controls scan hit
   `depthLimit` (`visited:434`) and never reached any file item, the selection, or the active F2
   edit box. No list-item pagination. → Guidance: shrink the list via search/filter, or use a
   `region` screenshot + point-click; do not expect `control_id` for items in huge lists.
3. **Address-bar autocomplete hijack.** `Ctrl+L` + typing a path can be overridden by history
   autocomplete and navigate into a child. → Guidance: after typing, verify the breadcrumb before
   Enter, or clear the field first.
4. **Context-menu items not click-operable via `control_id`.** Reading the menu works, but
   `execute_batch` on the menu HWND returns `window_activation_failed` and item clicks fail —
   Win32 shell context menus don't foreground normally and UIA Invoke is spotty. **The robust
   path is keyboard** (accelerators like `删除(D)`, or arrow+Enter). → Guidance documented; a
   native fix is high-risk/low-certainty and deferred.
5. **`geometry_changed` on window resize.** Correct safety behavior (prevents wrong-coordinate
   input); recovery is re-observe. Frequent when a window animates/resizes between observations.

No user files were touched; only the self-created throwaway folder was removed.

## Operational lesson (applies to all batches)
The 20-image request cap makes screenshot frugality essential. `get_window_state mode:"controls"`
is the default verification path; `region` crops (~26× smaller than full window) and controls-only
readback keep turns within limits. This is now baked into the round-2 subagent instructions.

## Batch 15 — Terminal / PowerShell (R41–R50): BLOCKED by a real capability gap
Target was **Windows Terminal** (elevated PowerShell tab). Keystrokes dispatched fine, but:

### HIGH-PRIORITY LIMITATION — GPU-rendered console content is unreadable
- **Controls:** the console content pane (`role:50025` Custom) has **`value:null`**; the buffer
  text is not in any UIA `value`. The only readable text is the title bar. An agent **cannot read
  console output via controls**.
- **Screenshot:** `win32.BitBlt` (the `screen` method) captured the Windows Terminal window as
  **solid black (#0a0a0a)** — BitBlt of the screen DC misses WT's DirectX swap-chain content.
  So the screenshot fallback also yields nothing.
- **Net:** DesktopPilot can type into Windows Terminal but is **blind to its output** — every
  `execute_batch` returns `status:ok` / `business_result_not_verified`, a false-success trap.

### Recommended fix direction (deferred — needs deliberate implementation, not a rushed change)
1. **Capture:** add a `Windows.Graphics.Capture` (WGC) path (or DXGI Desktop Duplication) for
   GPU-composited windows where BitBlt returns an (near-)all-black frame. `PrintWindow` with
   `PW_RENDERFULLCONTENT` (already supported as method `printWindow`) helps some modern apps but is
   unreliable for Windows Terminal specifically. A black-frame heuristic could auto-select WGC.
   (Could not A/B test live: no top-level WT/conhost window was open — only a 0-size
   `PseudoConsoleWindow` and VS Code's child terminal panes.)
2. **Console text:** expose UIA **TextPattern** (`ui.text`) content for the focused text surface in
   `get_window_state`, so terminals/editors that render via GPU but expose text for screen readers
   become readable without any screenshot. This is the more robust path for consoles.

### Other Batch 15 notes
- A `stale_window_ref` coincided with the elevated PowerShell WT window disappearing from
  `list_windows` (only harmless keystrokes were sent) — worth watching as a ref-lifetime concern.
- Classic `conhost.exe` consoles (real cmd.exe / legacy console host) are expected to capture
  correctly with BitBlt; the gap is specific to GPU-rendered hosts like Windows Terminal.

## Status
Round 2: Batch 11 (File Explorer) PASS-with-hazards; Batch 15 (Terminal) blocked by the WT capture
gap above. Remaining round-2 batches (12–14, 16–20) prepared in `100-cases-round2.md`, not yet run.

## Bonus finding — `drawing.drawPolyline` + explicit `stroke.width` fails
Discovered while drawing a flower (a stem via `drawPolyline` with `width:8`):
`{"status":"error","phase":"width","message":"control_not_unique: {\"name\":\"8px\"}"}`.
- Cause: for **shape/line tools** the shared `粗细` (width) menu lists line thicknesses whose
  labels match the profile `widthOptions` (`1px/3px/5px/8px`) — `drawCircle`/`drawLine` with
  `stroke.width` work. But `drawPolyline` is a **path** that selects the normal **brush** first,
  and the brush's `粗细` flyout is a different menu whose items don't expose a unique `8px` label,
  so the `widthOptions` selector matches ≠1.
- Impact: any `drawPolyline` with an explicit `stroke.width` errors. Workaround used: draw thick
  poly-lines as `drawLine` segments (line-tool width matches). Draw-fidelity note: line-segment
  joints are slightly angular vs a smooth brush path.
- Fix direction (needs live iteration + testing, deferred): give the Paint profile a
  brush-size selector set (or map `stroke.width` to the brush size control) for path shapes, or
  make `drawPolyline` reject `stroke.width` with a clear "unsupported for path" message instead of
  the cryptic `control_not_unique`. The width flyout is a multi-window popup
  (`SCENIC_DROPSHADOW_WINDOW_CLASS` + the list), so the profile needs the brush-menu structure.


