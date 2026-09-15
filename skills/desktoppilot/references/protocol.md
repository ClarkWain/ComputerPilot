# Compact protocol guide

MCP entrypoints: computer_runtime, computer_query, computer_inspect, computer_act,
computer_batch, computer_wait. Query runtime.describe for operation examples.

Single operation: {"operation":"window.list","args":{"titleContains":"Example"}}.
Batch: {"output":"summary","inputDefaults":{"windowRef":"<observed>","coordinateSpace":"window_relative"},"steps":[{"id":"click","operation":"input.click","args":{"x":100,"y":200}}]}.

An earlier step can be referenced as {"fromStep":"find","path":"/result/uniqueRef"}.
A before/after check has operation, args, pointer, equals and optional timeoutMs.
It must be read-only. Zero timeout checks once. Failure stops later steps.

For UIA text, ui.fill uses elementRef,text and optional method/timeoutMs;
ui.fill_form is documented by the server's operation reference. Avoid guessing
field selectors or repeated Submit actions. Read actual field values/results.

summary returns status/completed; failures also identify failedStep, phase and
dispatchAttempted. true does not prove the OS accepted input. all/last preserve
larger payloads. Include images only when visual inspection is needed.

screen_physical is virtual-screen pixels; window_relative/client_relative are
physical pixels relative to the live origin. expectedSize is whole-window size.
Window-bound input stops on foreground mismatch, unavailable target or occlusion.
Do not bypass that failure by dropping windowRef; reobserve the intended target.

MCP request IDs identify RPC calls. Action requestId is a separate session-local
deduplication key. After provider restart, refresh refs; after uncertain writes,
inspect business state before retrying.
