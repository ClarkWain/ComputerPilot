---
name: desktoppilot
description: Control Windows desktop applications through a configured DesktopPilot MCP server, using native UIA, window-bound input, screenshots and verified batches. Use when the user asks to operate desktop apps with DesktopPilot.
---

# DesktopPilot

Use the configured DesktopPilot MCP tools. This skill does not install the binary or grant access to a different desktop.

1. Read runtime.capabilities and system.session. Select a unique returned target window. Respect the user's window-size constraints.
2. Prefer native UIA references for fields and buttons. Query compact state, then read additional details only when needed. A truncated result cannot prove uniqueness.
3. Prefer ui.fill/ui.fill_form for verified text replacement. For coordinate input, bind windowRef and use window_relative or client_relative with observed expectedSize.
4. Batch predictable actions using inputDefaults, before/after and output:summary. Insert checks at focus, dialog and layout transitions. Use computer_wait for expected state changes.
5. An input receipt proves dispatch only. Verify the requested result. On timeout or unknown outcome, observe before retrying; reuse requestId only for identical requests.

Refs are session-local. After worker restart or stale geometry, refresh selection. If a modal appears, select that returned modal, rather than sending main-window coordinates into it. Do not automatically resize or repeatedly steal focus to recover.

For canvas work, confirm the selected tool, outline, fill and color before a drawing phase. Use native drawing gestures when the user asks to draw inside the app; importing an externally generated image is a different operation.

For exact tool arguments and recovery semantics, read [the compact protocol guide](references/protocol.md). Do not request full screenshots and full trees after every action when a small native condition answers the question. Preserve user authorization boundaries for external submissions.
