# Changelog

## 0.6.0 — ComputerPilot public launch

- Continue DesktopPilot with cleaned commit history, branches and historical tags retained.
- Rename executable, MCP configuration, skill and public SDK aliases to ComputerPilot; retain documented v1 compatibility identifiers.
- Add bilingual introductions and semantic diagrams, an SVG brand, actual Replay video/GIF and installation/migration guides.
- Publish Windows x64 and macOS arm64 Core archives with SHA-256 checksums. macOS binaries are unsigned and not notarized.
- Fix reviewed public-media packaging, add security/reporting guidance and public issue/PR entry points.
- Keep general orchestration on its historical experimental branch; it is not integrated into this native release.


## Unreleased

- Add explicit replay checkpoints after complete stroke groups and fresh-session resume with recipe/document hashes, exact AX document-path/save-state checks, observable-tool and canvas-pixel validation, atomic lifecycle markers and concurrent-run exclusion. Never resume uncertain or partially dispatched input from an obsolete checkpoint.

- Add opt-in MCP/replay call recording and offline recipe export with fresh control selectors, Retina/crop coordinate conversion, binary-state reconstruction and incomplete/failed-session rejection. Keep raw journals out of distribution packages; allow only the hash-checked flower reference image in package validation on Windows and macOS.

- Add a native `replay` CLI with complete preflight validation, fresh document creation, dynamic control/canvas resolution, color assertions and stop-with-progress behavior. Include the cleaned 12-stroke Preview flower recipe and reference image; MCP remains four tools.

- Validate the macOS native and public MCP paths against a disposable Cocoa fixture, including Unicode, Command+A, pointer paths, Retina crops and sheet handling. Fix sheet-control ownership checks using AX ancestry. See docs/MACOS-VALIDATION.md for scope.

- Classify macOS locked-session capabilities explicitly, keep unvalidated app writes disabled, pause UI batches with progress/outcome diagnostics, and invalidate old observations after observed session transitions. Background diagnostics and local vision processing remain available.

- Add a macOS 14+ native backend for window discovery, Accessibility inspection/fill/press, ScreenCaptureKit screenshots, and CGEvent input while retaining the four-tool MCP API.
- Add macOS permission/session preflight, Retina point/pixel mapping, worker timeout/cancellation recovery, core build/test support, onboarding, and core packaging. No macOS Paint/Aseprite profiles are introduced.

## 0.5.0 — 2026-09-24

- Improve UI Automation and worker failure handling: preserve screenshots when inspection fails, reject incomplete profile evidence, and invalidate stale references consistently.
- Add a modern Chinese Paint profile for the observed 11.2605.81.0 UI at 120 DPI and 100% zoom. It supports brush selection, RGB and width readback, continuous paths, and bucket fill; unsupported layouts are rejected.
- Extend the classic Chinese Paint profile to 120 DPI while retaining UI fingerprint checks. Classic Paint 120 DPI live rendering remains unverified.
- Add an Aseprite v1.2.15 English profile at 120 DPI with stock tool/zoom hotkeys and generic clicks. OCR menu navigation is advertised only by OCR-enabled builds. Pixel drawing and save actions are not included.
- Remove Aseprite's fixed-coordinate Save As action because it could confirm overwrites and report success without evidence.
- Keep the four-tool MCP API unchanged. Default Core releases do not include OCR or model weights.

Validation limits: modern Paint's verified range is limited to the documented version/layout; Aseprite support does not prove arbitrary hotkey customization or UI layouts. See `docs/RELIABILITY-VALIDATION.md` and `docs/PAINT-VERSION-ADAPTATION.md` for the recorded evidence and outstanding real-desktop checks.

## 0.4.0 — 2026-09-16

- **Breaking MCP API change:** replace the previous tools with `list_windows`, `get_window_state`, `execute_semantic`, and `execute_batch`. Refresh client tool discovery and migrate calls using `docs/MCP.md`; legacy aliases are not retained.
- Add application profiles matched against executable, window class, DPI, layout and controls. The classic Chinese Paint profile supports drawing, text, brush selection and saving, with shared control lookup and optional style reuse within a batch.
- Check the Windows session/input desktop before operating. Recover target focus for foreground input and report modal blockers instead of sending input to another window.
- Add compact continuous mouse paths, including button-held movement, and prefer UI Automation invocation where supported.
- Return bounded screenshots (maximum edge 1600), local crops and WebP with PNG fallback. Map displayed screenshot coordinates back to the source window.
- Add onboarding fixtures, examples, generated tool reference, skill installation and regression coverage. Package profiles and the WebP license with the core release.
- Remove experimental per-shape pixel sampling and its success flags. A successful drawing receipt confirms dispatch; the Agent must inspect the final image. Small native Paint polygons remain unreliable, and experimental scanline drawing is not an automatic semantic backend in this release.

Validation: 17 non-interactive tests pass locally. Interactive checks are separate and do not establish universal application or lock-screen support.

## 0.3.0

Initial standalone repository release.

- Native Windows window/UIA discovery, capture, input and verified form filling.
- MCP stdio and JSONL transports with worker supervision and action receipts.
- Window-relative input, batch pre/post checks, compact results and cancellation.
- Optional native icon detection, and OCR backends.
- Windows CI, core release packaging, C++ example and agent skill.
