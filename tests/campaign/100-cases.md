# DesktopPilot 100-Case Real-Usage Campaign

Purpose: exercise the four public MCP tools against real Windows apps to widen coverage,
surface reliability / design / token problems, and drive fixes. Executed by subagents
(Claude) via the `desktop-pilot` MCP server; project lead monitors and optimizes.

Legend for status: PASS / FAIL / PARTIAL / BLOCKED / SKIPPED. Findings tracked in `results.md`.

Global safety rules for every executor:
- Always `list_windows` fresh (window_ids change per server reconnect).
- Never send messages in WeCom/WeMail/X or any chat app. Never close user windows
  (only close browser tabs the test itself opened). Never overwrite user files.
- Paint `document.saveAs` only under `%TEMP%`. Do not disrupt the VS Code window.
- Screenshots return as PNG. Report the actual JSON field values you observe.

## Batch 1 — Connectivity & observation (C01–C10)
- C01 list_windows returns status ok and a non-empty windows array incl. Paint/Notepad++/Calculator.
- C02 get_window_state mode:controls on Notepad++ returns controls array.
- C03 get_window_state mode:both on Paint returns semantic.profiles with id mspaint-classic-zh-CN + action names.
- C04 get_window_state mode:image on Paint → mimeType image/png, coordinateSpace image_pixels.
- C05 get_window_state region {x:0,y:0,width:320,height:200} on Paint → lossless region crop.
- C06 get_window_state activate:false mode:controls on a background window → read-only, no activation.
- C07 get_window_state on window_id "w-does-not-exist" → unknown_window error.
- C08 get_window_state mode:both on Notepad++ → semantic.profiles empty + unavailable reasons.
- C09 get_window_state mode:controls on Settings (设置) → observe truncated flag if >80 controls.
- C10 second list_windows in same session → window_ids stable vs C01.

## Batch 2 — Notepad++ basic text input (N11–N20)
- N11 type_text "Hello DesktopPilot" → verify via region screenshot.
- N12 press_keys Ctrl+A then type_text to replace whole buffer.
- N13 press_keys End then Enter then type_text second line.
- N14 press_keys Ctrl+Home then Ctrl+Shift+End (select all) → observe.
- N15 type_text Chinese "你好，桌面 Pilot" → verify rendering.
- N16 type_text with symbols "a=b; c+d (e)! 100%" → verify.
- N17 fill_text on an editable control if one is exposed; else record that Scintilla has no value control.
- N18 multi-action batch: Ctrl+A, Delete(press_keys), type_text, verify empty→filled.
- N19 press_keys Ctrl+Z (undo) then Ctrl+Y (redo) → observe.
- N20 press_keys Ctrl+End then type marker; confirm caret behavior.

## Batch 3 — Calculator (K21–K30)
- K21 find a Calculator window that activates; get controls; identify digit/operator buttons.
- K22 click 7, +, 3, = via control_id → verify display shows 10.
- K23 press_keys "5", "*", "6", "=" → verify 30.
- K24 compute 12 − 4 via clicks → verify 8.
- K25 clear (Escape or C) → verify display 0.
- K26 percentage or 1/x simple op if available → verify.
- K27 confirm controls expose the running display value.
- K28 count:2 double-click on a safe button → observe no crash.
- K29 point-based click using screenshot pixel coords on a digit → verify.
- K30 error: click action with BOTH control_id and point → schema rejects; and invalid control_id → error.

## Batch 4 — Paint semantic shapes I (P31–P45)
- P31 drawCircle center [200,200] r 80 fill [255,0,0].
- P32 drawCircle center [430,200] r 60 fill:null (outline only).
- P33 drawEllipse position [520,140] size [180,110] stroke {color:[0,0,0],width:3}.
- P34 drawRectangle position [120,340] size [180,120] fill [0,0,255].
- P35 drawRoundedRectangle position [340,340] size [180,120] fill [0,180,0].
- P36 drawLine from [120,520] to [420,600] stroke width 5.
- P37 drawPolygon triangle points [[200,640],[320,640],[260,540]] fill [255,180,0].
- P38 drawPolygon pentagon 5 verts.
- P39 drawPolyline open path 4 pts.
- P40 drawPolyline closed:true.
- P41 drawText position [140,60] size [240,60] text "DP".
- P42 style reuse: two circles in one batch; second omits fill/stroke.
- P43 fill:null vs omitted fill difference.
- P44 stroke color variations across shapes.
- P45 one execute_semantic batch mixing circle+rectangle+line.

## Batch 5 — Paint brushes & save (P46–P58)
- P46..P54 selectBrush each: brush, calligraphy1, calligraphy2, airbrush, oil, crayon, marker, pencil, watercolor → verify tool readback.
- P55 selectBrush watercolor then execute_batch move hold:left freehand stroke; verify mark.
- P56 document.saveAs %TEMP%\dp-test-1.png → verify file exists & decodes.
- P57 saveAs to same existing path overwrite:false → refuse.
- P58 saveAs relative path or non-.png → error.

## Batch 6 — Paint error / edge cases (P59–P70)
- P59 drawCircle radius 1 (<2) → error.
- P60 drawCircle center [40000,40000] out of canvas → error.
- P61 drawPolygon degenerate (duplicate adjacent verts) → error.
- P62 drawLine equal endpoints → error.
- P63 drawPolygon 2 verts (<3) → error.
- P64 drawText with unsupported font/size arg → error.
- P65 selectBrush invalid name → error.
- P66 stroke.width 2 (not in {1,3,5,8}) → error.
- P67 execute_semantic explicit wrong profile id → revalidation/mismatch.
- P68 execute_semantic empty actions → error.
- P69 execute_semantic 257 actions → error.
- P70 execute_semantic omit profile (auto-select) on Paint → works.

## Batch 7 — Paint precision & reliability (P71–P80)
- P71 small triangle (~20px) → inspect for known small-polygon failure.
- P72 dense polygon (~40 verts near-circle) → simplification behavior.
- P73 draw circle then region screenshot → check center/radius placement accuracy.
- P74 resize Paint narrow (<1100) then get_window_state → toolbar_too_narrow; restore after.
- P75 draw large radius circle r 300.
- P76 two drawText boxes.
- P77 color readback: draw pure red rect, region crop, sample pixel ≈ (255,0,0).
- P78 stroke width 8 thick line.
- P79 sequential execute_semantic batches reuse tool/color.
- P80 drawEllipse tall/thin aspect.

## Batch 8 — Browser Edge/Chrome (B81–B88)
- B81 Edge: Ctrl+T new tab, Ctrl+L, type "about:blank", Enter → verify title.
- B82 Edge: navigate address bar to "example.com" → read resulting title.
- B83 Chrome: Ctrl+T, navigate "about:blank" → read title.
- B84 get_window_state mode:both on a browser → large controls, note truncated + payload size.
- B85 identify the address/omnibox control from controls.
- B86 navigate a data: URL containing an input, fill_text it (if control exposed) or type_text.
- B87 press Escape / Back behavior.
- B88 cleanup: Ctrl+W to close only the tab this batch opened.

## Batch 9 — Error handling & recovery (E89–E95)
- E89 execute_batch on unknown window_id → unknown_window.
- E90 execute_batch empty actions → error.
- E91 execute_batch 257 actions → error.
- E92 move hold:left with a single point → error (needs ≥2).
- E93 move points wildly out of range → error or clamp; record.
- E94 click point far outside window bounds → record behavior.
- E95 observe Paint, then note geometry_changed semantics if window moves (best-effort).

## Batch 10 — Token / efficiency & mode discipline (T96–T100)
- T96 same window: compare approx payload of mode:controls vs both vs image.
- T97 region crop small vs full-window screenshot byte/size comparison.
- T98 field verification using controls-only (no screenshot) — confirm sufficient.
- T99 repeated get_window_state → observation reuse / referencesInvalidated behavior.
- T100 summarize the largest-payload calls and token-reduction opportunities.
