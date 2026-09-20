# DesktopPilot 100-Case Campaign — Results & Findings

Executor: subagents (Claude) via the `desktop-pilot` MCP server. Lead: monitoring + fixes.
Environment: Windows @ 150% scaling (144 DPI), classic zh Paint, Notepad++, Calculator, Edge/Chrome.

## Executive summary
Two **critical, previously-undetected bugs** were found and **fixed** (both blocked core usage),
25 of 100 cases were executed with real desktop operations before the Windows **session locked**
(hard external blocker for the remaining input-driven cases). Deeper drawing-reliability bugs were
isolated and characterized for follow-up.

## Fixes landed (code + tests)
### FIX 1 — Screenshots broke Claude-hosted agents (CRITICAL)
- Symptom: any `get_window_state` screenshot killed the agent turn with HTTP 400
  `image/webp media type but appears image/png` on the Anthropic/Claude transport.
- Cause: default screenshot format was WebP; MCP has no image-format negotiation and the
  Copilot→Claude transport rejects/mislabels WebP. PNG is universally accepted.
- Fix: `src/agent_api.cpp` — default to PNG; WebP only when `DP_IMAGE_FORMAT=webp`.
- Verified: screenshots now return `image/png` and render on Claude with no error (25+ image calls, 0 failures).

### FIX 2 — Paint profile unusable on high-DPI displays (CRITICAL)
- Symptom: on 144 DPI, `mspaint-classic-zh-CN` never matched → `control_not_unique:ellipse`
  with an unhelpful dead-end message; all semantic drawing impossible.
- Cause: the `minimumWindowWidth` gate was compared in **physical** px, but Paint's ribbon
  Shapes gallery collapses based on **logical** width. At 144 DPI a 1270px window (~847 logical)
  keeps the gallery collapsed, so `椭圆形` isn't in the tree — yet `1270 > 1100` passed the gate.
- Fix: `src/profiles.cpp` — scale the width gate by DPI (`minimumWindowWidth * dpi/96`), so a
  too-narrow high-DPI window reports the actionable `toolbar_too_narrow` (+ maximize-via-Win+Up
  guidance) instead of a missing-control dead end. Test updated; all 17 core tests pass.
- Verified: after widening Paint (0→23 shape ListItems), the profile matches and drawing runs.

## Cases executed (25 of 100)

### Batch 1 — Connectivity & observation (C01–C10): 10/10 PASS
- All tools reachable from subagents; window_ids stable within a session; `unknown_window`,
  `activate:false`, region crop, image PNG, controls/both all behaved correctly.
- Findings: (a) `geometry_changed` fired transiently on an animating Settings window (retry
  worked); (b) Notepad++ dumps the **entire document text as a single control `name`** (~35KB) —
  payload bloat; (c) duplicate app titles (two 计算器 / two 设置) make title-only selection
  ambiguous — pid disambiguation advised.

### Batch 4 — Semantic Paint drawing (P31–P45): mixed — key reliability signal
- SOLID: filled shapes render correctly and fast (110–530ms): drawCircle(fill), drawRectangle,
  drawRoundedRectangle, drawPolygon(fill), and mixed batches. Fill-style **reuse works** within a
  call and across calls; `fill:null` (outline) is treated differently from omitted fill.
- BUG A — `stroke.width` deterministically fails: P33 (ellipse w3) & P36 (line w5) returned
  `error phase:"width" input_point_occluded`, leaving the width/outline dropdown stuck open
  (requires observe+Escape). Reproducible; not lock-related.
- BUG B — silent no-op (reports `status:ok` but nothing drawn): `fill:null` outline circle,
  `drawLine`, `drawPolyline` (also ~13× slower, ~6.5s), `drawText`. Most dangerous class:
  false success signal with no result.
- Correct behaviors observed: `window_blocked` returns blocking dialog identity; `state_required`
  guard forces re-observation after a failure; no worker crash/restart.

### Environmental blocker
- Mid-Batch-4 the Windows session **locked**; preflight correctly returned `session_locked` /
  `input_desktop_unavailable` and stopped rather than retrying. Remaining batches (2,3,5–10)
  require an **unlocked, interactive** session to execute.

## Additional fixes landed (session 2, after unlock)

### FIX 3 — Control-name/value token bloat
- `get_window_state` controls dumped an entire editor buffer as one control `name` (~35KB, Notepad++).
- Fix: `src/agent_api.cpp` caps agent-facing control `name` at 256 and string `value` at 2048 chars
  (UTF-8-safe truncation with a `…[+N]` marker). Full elements still retained internally for input.

### FIX 4 — Bug A `stroke.width` occlusion (semantic drawing) — FIXED & verified
- Root cause: the `轮廓` (outline) flyout popup (x≈525–660) horizontally covers the `粗细` (width)
  button (x≈595). The code opened the outline menu before the width menu, so the width toolbar
  click was always occluded → `input_point_occluded` at `phase:"width"`, leaving the menu stuck.
- Fix: `src/semantic.cpp` sets **width before outline** (the width flyout opens to the right, clear
  of the outline button), plus a flyout-dismiss safety net. Verified live: `drawCircle` with
  `stroke.width:5` now returns `status:ok` and a thick-outlined circle renders; menu closes cleanly.

### Bug B — reassessed
- With the session unlocked, `drawLine`, `drawText`, and `drawPolyline` all render correctly. The
  earlier "silent no-op" was the Windows session locking mid-batch, not a drawing defect.
- Only `drawCircle {fill:null}` with NO stroke is invisible (no fill + no outline) — arguably the
  requested result; a footgun rather than a crash.
- `drawPolyline` is ~14× slower (~6.7s) than comparable shapes — a performance note, not a defect.

## Open follow-ups
1. `drawPolyline` latency (~14×) — investigate per-point settle in the path dispatch.
2. `fill:null` + no stroke → invisible: consider warning or defaulting outline to solid.
3. Ambiguous window selection (duplicate app titles) — consider extra disambiguators.
4. A failed stroke-width attempt (pre-fix) could leave the outline menu open, tripping the next
   call's preflight (`control_not_unique:轮廓`); the reorder avoids opening it in the bad order.

### FIX 5 — Bug C `selectBrush` unreliable on consecutive calls — FIXED & verified
- Symptom: every `selectBrush` after the first failed first-attempt with `expected_popup_not_ready`;
  a prior selection left the brush gallery open, so the next `刷子` click toggled it *closed*.
- Fix: `src/semantic_actions.cpp` — if no gallery popup appears, re-click the brush button once
  before timing out. Verified live: two consecutive `selectBrush` calls now both return `status:ok`.
  (Latency is still ~6–7s per brush select — a perf follow-up.)

### FIX 6 — Bug D `document.saveAs` forward-slash path — FIXED & verified
- Symptom: a `C:/...` path (the profile's own example format) was typed verbatim into the Windows
  Save dialog, rejected as `文件名无效`, leaving orphaned dialogs.
- Fix: `src/semantic_actions.cpp` — normalize `/`→`\` before typing the filename. Verified: a
  forward-slash path now writes a valid PNG (correct `89 50 4E 47` signature).
- Minor residual: the post-save verification can race the file flush and report
  `saved_format_not_png` even though the file is a valid PNG — a small follow-up (retry the
  signature read before failing).

## Summary of landed fixes (all rebuilt, 17/17 core tests pass)
1. WebP→PNG default (Claude-host compatibility) — CRITICAL
2. DPI-aware toolbar-width gate (high-DPI Paint) — CRITICAL
3. Control name/value token cap (payload bloat)
4. Bug A: width-before-outline reorder (stroke.width occlusion)
5. Bug C: brush-gallery re-open retry (consecutive selectBrush)
6. Bug D: saveAs forward-slash path normalization

Cases executed with real desktop operations: Batches 1, 4, 5, 6, 7 (plus targeted repro/verify
runs) ≈ 60 of 100. Remaining breadth (Notepad++, Calculator, browser, generic error/token batches)
pending.

## Batches 2, 3, 9, 10 — executed (basic input, protocol, token)
- Batch 2 (Notepad++): text input, Chinese, punctuation, Ctrl+A/Delete/Enter all PASS. Scintilla
  exposes no editable value control (text is a Pane `name`), so verify by region screenshot.
- Batch 3 (Calculator): 7+3=10, 5*6=30, 12−4=8, Escape-clear all PASS; results verified
  controls-only via the display Text. `press_keys` correctly rejects punctuation (`*`,`=`) with a
  clear message (use `type_text`). Stale `control_id` after UI change is correctly rejected.
- Batch 9 (protocol): empty actions, single-point held move, out-of-bounds click, stale-state guard
  all reject correctly with `dispatch:not_started` (no stray input). NOTE: `execute_batch` on an
  unknown window returns `state_required` (the state guard runs before the existence check) instead
  of `unknown_window` — a minor error-code inconsistency.
- Batch 10 (token): **token-cap fix CONFIRMED** — a 2,724-char Scintilla buffer name was capped to
  `…[+2470]` and controls stayed ~20KB. Region crop (300×200 ≈ 19KB PNG) is ~26× smaller than a
  full-window screenshot (~502KB PNG). Controls-only verification is sufficient for field/result checks.

## Additional follow-ups (minor)
5. Full-window PNG screenshots are ~500KB (vs the former ~40KB WebP). PNG is required for
   Claude-host correctness; mitigate cost with `region` crops and controls-only verification.
   (Model image tokens scale with dimensions, not bytes, so token cost is largely unchanged.)
6. `execute_batch` unknown-window returns `state_required` rather than `unknown_window` — consider
   checking window existence before the state guard for a clearer error.
7. Calculator UWP splash/phantom windows expose only title-bar controls while loading; the state
   JSON has no explicit "app still loading" hint (accurate but potentially misleading to an agent).

## Coverage
~90 of 100 cases exercised with real desktop operations across Batches 1–7, 9, 10. Browser (Batch 8)
was deprioritized to avoid disturbing the user's live browser session.

## Test artifacts
- `tests/campaign/100-cases.md` — the case matrix.
- `tests/campaign/dump-tree.ps1`, `test-resize.ps1` — out-of-band jsonl inspection helpers used to
  isolate FIX 2.
