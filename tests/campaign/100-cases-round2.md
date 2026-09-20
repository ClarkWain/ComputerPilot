# DesktopPilot — Round 2: 100 More Real-Usage Examples

Broader coverage of common Windows software and interaction patterns, complementing
`100-cases.md` (which focused on Paint, Notepad++, Calculator, browser, Settings, protocol).
These are **prepared** cases to be executed by subagents via the four MCP tools
(`list_windows`, `get_window_state`, `execute_semantic`, `execute_batch`).

Global safety rules (same as round 1):
- Always `list_windows` fresh; disambiguate by pid when titles collide.
- Never send messages in chat/email apps; never delete or overwrite user files; use `%TEMP%`
  or newly-created throwaway items only. Never disrupt the VS Code host window.
- Browser/File-Explorer/Terminal: operate on new tabs / new windows / throwaway paths you create,
  and clean them up. Prefer `region` crops and controls-only verification to bound tokens.
- Screenshots return as PNG. Verify with a fresh `get_window_state`; dispatch ok ≠ visible result.

Status legend: PASS / FAIL / PARTIAL / BLOCKED / SKIPPED.

## Batch 11 — File Explorer / 资源管理器 (R01–R10)
- R01 Open a new File Explorer window (Win+E via press_keys on the desktop/shell) and identify it.
- R02 get_window_state controls → identify the address bar, search box, file list (Items view).
- R03 Navigate: click the address bar (or Ctrl+L), type `%TEMP%`, Enter → verify breadcrumb/title.
- R04 Create a new folder: press_keys Ctrl+Shift+N, type a unique name `dp-test-<ts>`, Enter → verify it appears in the list.
- R05 Rename that folder: select it, F2, type a new name, Enter → verify rename via controls.
- R06 Search within the folder: type in the search box, observe filtered results.
- R07 Switch view (details/large icons) via the ribbon/View menu → verify layout change by screenshot.
- R08 Select multiple items with Ctrl+click (if items exist) → verify selection count in status bar.
- R09 Open the context menu (right-click / Shift+F10) on the created folder → read menu items (do NOT delete).
- R10 Cleanup: delete ONLY the `dp-test-<ts>` folder you created (Del), confirm it is gone; close the Explorer window you opened.

## Batch 12 — Classic Notepad (记事本) & WordPad (R11–R20)
- R11 Launch Notepad (if not open, via Start search or run) and identify its window.
- R12 type_text a paragraph → verify via controls/region.
- R13 press_keys Ctrl+A, Ctrl+C; then Ctrl+End, Enter, Ctrl+V (paste) → verify duplication.
- R14 Find & Replace: Ctrl+H, fill find/replace fields in the dialog, replace all → verify text changed.
- R15 Word wrap toggle via the Format/View menu → verify layout.
- R16 Save As to `%TEMP%\dp-notepad-<ts>.txt` via the save dialog (fill filename control) → verify file exists; do not overwrite existing.
- R17 Zoom in/out (Ctrl+ +/-) if supported → verify status bar zoom %.
- R18 WordPad: type text, select a range, apply Bold (Ctrl+B) via ribbon → verify by screenshot.
- R19 WordPad: change font size via the ribbon size control → verify.
- R20 Cleanup: close Notepad/WordPad WITHOUT saving over user files (discard the throwaway or keep in %TEMP%).

## Batch 13 — Calculator: Scientific / Programmer / Converter (R21–R30)
- R21 Open Calculator; switch to Scientific mode via the hamburger/navigation menu → verify mode.
- R22 Compute sin(30) or sqrt(2) via buttons → read display, sanity-check the value.
- R23 Use memory: M+, MR, MC → verify memory panel/readback.
- R24 Switch to Programmer mode → verify; enter a hex value, read the decimal equivalent.
- R25 Toggle bit width (BYTE/WORD/DWORD) → observe.
- R26 Switch to a converter (Length/Temperature) → convert a value, read the result.
- R27 History panel: perform 2 ops, open history, verify entries.
- R28 Keyboard entry in scientific mode (type digits/operators via type_text) → verify.
- R29 Error case: divide by zero → read the error message the app shows.
- R30 Switch back to Standard mode → verify.

## Batch 14 — Windows Settings (设置) deep navigation (R31–R40)
- R31 Open Settings; use its search box to search "display" → verify results.
- R32 Navigate to System > Display via the left nav → verify the pane title.
- R33 Read the current display scale/resolution values (controls-only).
- R34 Navigate to Bluetooth & devices (or 蓝牙和其他设备) → read device list (do not pair/remove).
- R35 Toggle a safe switch and toggle it back (e.g., a non-destructive UI toggle) → verify state round-trips.
- R36 Navigate via back button → verify navigation stack.
- R37 Open Apps > Installed apps, scroll the list → verify scrolling changes visible items.
- R38 Settings search for "about" → open System > About, read the device name (controls-only).
- R39 Handle a Settings sub-dialog if one opens (e.g., advanced) → read and close it.
- R40 Confirm no setting was permanently changed; leave Settings as found.

## Batch 15 — Terminal / PowerShell / CMD (R41–R50)
- R41 Identify an open PowerShell/Terminal window (or open one) — do NOT run destructive commands.
- R42 type_text a harmless command `echo DesktopPilot`, Enter → read the echoed output from the buffer.
- R43 type_text `Get-Date` (PS) or `date /t` (cmd), Enter → verify a date string appears.
- R44 Use Ctrl+C to cancel a partially typed line → verify prompt returns.
- R45 Clear screen: type `cls`/`clear`, Enter → verify buffer cleared.
- R46 Read the current directory: `pwd` / `cd` → parse the path from output.
- R47 Tab-completion: type a partial path and press Tab → observe completion.
- R48 Scroll back through history (Up arrow) → verify prior command recalled.
- R49 Verify the console exposes text via UIA (or fall back to region screenshot + read).
- R50 Do NOT close the user's shell; leave it at a clean prompt.

## Batch 16 — Browser advanced scenarios (R51–R62)
- R51 New tab; navigate to a search engine; type a query; submit → read the results page title.
- R52 Identify result links from the rendered page (screenshot) vs control order; report the first organic result.
- R53 Open a result in a new tab (Ctrl+click or middle-click via move) → verify a new tab opened.
- R54 Fill a simple form on a data: URL (an input + button) → verify the value via controls or screenshot.
- R55 Use in-page find (Ctrl+F), type a term → verify the highlighted match count.
- R56 Zoom the page (Ctrl+ +) → verify layout change; reset (Ctrl+0).
- R57 Navigate back/forward (Alt+Left/Right) → verify title transitions.
- R58 Read a paragraph of page text from the accessibility tree or a region crop; report it verbatim.
- R59 Switch between tabs (Ctrl+Tab / Ctrl+1..9) → verify active tab title.
- R60 Open DevTools? SKIP (host risk) — instead open the browser menu (Alt+E / ...) and read items, then Escape.
- R61 Handle a cookie/consent banner if present → dismiss it, then re-observe.
- R62 Cleanup: close ONLY the tabs this batch opened (Ctrl+W each) → verify user tabs intact.

## Batch 17 — Office / WPS (Word & Excel-like) (R63–R72)
- R63 Identify an open Word/WPS 文字 document (or a new blank one) — do not save over user files.
- R64 Type a heading, select it, apply a Heading style via the ribbon → verify by screenshot.
- R65 Insert a bulleted list (ribbon) and type items → verify.
- R66 Use Find & Replace (Ctrl+H) → replace a token, verify.
- R67 Excel/WPS 表格: click cell A1, type a value, Enter → verify the cell content via controls.
- R68 Enter a formula in B1 `=A1*2` after A1=21 → verify B1 shows 42.
- R69 Select a range (Shift+arrows), read the status-bar Sum/Count.
- R70 Fill a small 3×3 table of numbers via Tab/Enter navigation → verify.
- R71 Sort or filter a column via the ribbon (if data present) → verify order changed.
- R72 Cleanup: leave documents unsaved or save only to `%TEMP%`; do not overwrite user files.

## Batch 18 — System apps: Task Manager, Clock, Photos, Snipping (R73–R82)
- R73 Open Task Manager (Ctrl+Shift+Esc); read the Processes tab → list a few process names (read-only, do NOT end tasks).
- R74 Switch to the Performance tab → read CPU/Memory values (controls or region).
- R75 Sort the process list by a column → verify order changed.
- R76 Open Clock/Alarms app; read current time; add a throwaway timer (do not rely on it firing) → verify it appears, then remove it.
- R77 Photos app: open it, navigate the collection (do not delete) → read an image's metadata if shown.
- R78 Snipping Tool: open it, start a rectangular snip on a small region → verify a capture preview (do not save over anything).
- R79 Sticky Notes / a note app: create a note, type text, verify; then delete the throwaway note.
- R80 Character Map or Emoji panel (Win+.) in a text field → insert a glyph, verify.
- R81 Magnifier/Narrator: SKIP (accessibility side effects) — just confirm they are NOT toggled.
- R82 Close only the apps this batch opened; leave user apps untouched.

## Batch 19 — Interaction patterns (context menu, drag, dialogs, clipboard) (R83–R92)
- R83 Right-click (or Shift+F10) a target and select a menu item by control_id → verify the action.
- R84 Drag an item a short distance with `move hold:left` within one window → verify it moved.
- R85 Hover to reveal a tooltip/submenu (move without hold) → observe the revealed element.
- R86 Handle an Open File dialog: navigate, type a filename, confirm → verify selection (in a safe app).
- R87 Handle a Save As dialog with overwrite refusal (existing file) → verify the app's refusal path.
- R88 Handle a confirmation message box (Yes/No/Cancel) → click the safe option and verify dismissal.
- R89 Clipboard round-trip: copy text in app A (Ctrl+C), paste into app B (Ctrl+V) → verify content transferred.
- R90 Multi-select + bulk action in a list (Ctrl+A then a safe operation) → verify.
- R91 Keyboard-only navigation: Tab through a dialog's controls, Space/Enter to toggle → verify focus order.
- R92 Double-click (count:2) to activate an item → verify it opened/expanded.

## Batch 20 — Cross-app workflows & robustness (R93–R100)
- R93 Copy a computed Calculator result and paste it into Notepad → verify the pasted number.
- R94 Read a value from Settings and type it into a Notepad note → verify.
- R95 Alt+Tab / window switch between two apps via list_windows + activation → verify foreground changes.
- R96 A window that is minimized: observe (activate:true restores) → verify it comes forward, then re-minimize.
- R97 A modal dialog blocking its parent: confirm `window_blocked` is reported with the dialog identity; act on the dialog.
- R98 A window moved/resized mid-task: confirm `geometry_changed` and re-observe recovery.
- R99 Rapid consecutive batches on the same app: confirm the state_required guard and re-observation flow.
- R100 Token-efficiency sweep: for one complex app, compare controls-only vs region vs full-image payloads and record which verification path is cheapest.

---
Notes for executors: prefer semantic profiles only where one actually matches (currently just
classic zh Paint); everything above is basic-input driven. Report per-case status, exact codes,
and any newly discovered bug, false-success, latency, or token concern — the goal is to widen the
reliability surface and surface fixes.
