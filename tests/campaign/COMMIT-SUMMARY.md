# Commit summary — DesktopPilot reliability fixes (session)

> **Do NOT `git commit` blindly.** These source files already contained *uncommitted* changes
> before this session (the user's prior in-progress work). `git diff` therefore mixes those
> pre-existing edits with the changes below. Review and stage selectively before committing.

## Suggested commit message
```
fix: PNG-default screenshots, DPI-aware Paint gate, and semantic drawing reliability

- Screenshots default to PNG (WebP opt-in via DP_IMAGE_FORMAT=webp) so Claude/Anthropic
  hosts no longer reject the whole turn on a webp/png MIME mismatch.
- Scale the Paint toolbar-width gate by DPI so high-DPI (e.g. 150%) windows report the
  actionable toolbar_too_narrow instead of a dead-end control_not_unique.
- Cap oversized control name/value in get_window_state to bound tokens.
- drawing: set stroke width before outline (the outline flyout occluded the width button);
  re-open the brush gallery if the first click closed a stale one; normalize '/'→'\' in
  document.saveAs paths. Add Bug A/C/D regression tests.
```

## Files I changed (exact logical edits)

### src/agent_api.cpp
1. Screenshot format default flipped to PNG: the observe path now emits WebP **only** when
   `DP_IMAGE_FORMAT=webp` (was: WebP unless `=png`). Fixes hard 400s on Claude hosts.
2. Control payload cap: agent-facing control `name` truncated at 256 chars and string `value`
   at 2048, on UTF-8 boundaries with a `…[+N]` marker. Full elements still retained internally.

### src/profiles.cpp
- `toolbar_too_narrow` gate is now DPI-aware: `requiredWidth = minimumWindowWidth * dpi/96`.
  At high DPI a physically-"wide-enough" window whose ribbon gallery is still collapsed now
  correctly reports `toolbar_too_narrow` (with a maximize/Win+Up hint) instead of the
  misleading `control_not_unique:<selector>`.

### src/semantic.cpp
- In the shape-drawing flow, configure **width before outline** (`setWidth` menu before
  `setOutline` menu). The outline flyout popup horizontally overlaps the width button, so the
  old order occluded the width click (`input_point_occluded`, `phase:"width"`). Also added a
  best-effort flyout-dismiss (activate main window + Escape) after selecting a menu item.

### src/semantic_actions.cpp
1. `document.saveAs`: normalize `/`→`\` before typing the filename (the Windows save dialog
   rejects forward slashes → `文件名无效`). Added `#include <algorithm>`.
2. `selectBrush`/openBrush: if no gallery popup appears after clicking the brush button, re-click
   it once before timing out (a prior selection can leave the gallery open so the first click
   toggles it *closed*).

### tests/profile_selection_tests.cpp
- Updated for the DPI-aware width gate: 144-DPI now needs ~1650px; added an assertion that a
  narrow high-DPI window reports `toolbar_too_narrow` (not a missing control).

### tests/semantic_tests.cpp
- Added regression tests: **Bug A** (width menu opened before outline menu), **Bug C**
  (selectBrush re-opens a stale-closed gallery), **Bug D** (forward-slash save path normalized).
  Added `<algorithm>`/`<vector>` includes.

## Verification
- `cmake --build --preset core-only` + `ctest --preset core-only -LE interactive` → **17/17 pass**.
- All six fixes were additionally verified live against the running MCP server (see `results.md`).

## Files I did NOT touch (pre-existing uncommitted work — leave for the user)
README.md, CMakeLists.txt, docs/*, include/*, src/desktop_windows.cpp, src/service.cpp,
tests/agent_api_tests.cpp, tests/desktop_tests.cpp, and other `M` entries in `git status`.
