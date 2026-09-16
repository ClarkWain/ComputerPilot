# Changelog

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
