# Reliability validation — 2026-09-18

An independent subagent reviewed the changes and performed the checks below. This
report distinguishes mock/unit coverage, native provider tests, and the real Paint
acceptance test; passing one category does not substitute for another.

## Review findings and corrections

- Centralize worker reference invalidation across all AgentApi dispatches, not
  only profile discovery. Old windows and observations must be discarded after
  failures during window inspection, capture, semantic execution, or basic input.
  The implementation now does this and propagates the reset through batch errors.
- Retain complete uniqueness evidence. Pagination, depth truncation, provider
  failure, and incomplete typed evidence are rejected rather than accepted as a
  profile match. Execution-local reuse rechecks window and input-session identity.
- UIA initialization is lazy, so failure to initialize UIA does not prevent Win32
  window observation and screenshots. UIA connection and transaction timeout
  settings are verified after configuration; query budgets remain separate.
- The new out-of-process slow-provider fixture initially failed before reaching
  UIA because console-process `WaitForInputIdle` did not establish window readiness.
  Independent execution caught this. The fixture now uses an explicit ready event
  and monitors early child exit.

## Executed checks

| Check | Observed result | Evidence |
|---|---|---|
| `ctest --preset core-only -LE interactive --output-on-failure` | 17/17 passed; final run 2.57 seconds total | `out/reliability-validation/noninteractive-final.log` |
| Initial slow-provider native test | Failed in 0.05 seconds: fixture window not found; test synchronization subsequently corrected | `out/reliability-validation/provider-initial-failure.log` |
| Corrected `native-provider-timeout` | Passed; actual blocked provider rejected in 2226.04 ms (CTest 2.29 seconds) | `out/reliability-validation/provider-timeout.log` |
| MCP preflight in permitted normal session | Blocked: `ready:false`; no fixture launch or input sent | `out/reliability-validation/paint/preflight.json` |

The slow provider really entered its eight-second blocked Name-property callback.
The query returned `stopReason:providerError`, `truncated:true`,
`evidenceComplete:false`, and `uniqueRef:null`; recorded property retrieval was
2208.68 ms. This is actual cross-process UIA failure evidence, not a mocked timeout.
The AgentApi and semantic state/error regressions in the 17-test suite use mocked
dispatchers and do not establish successful desktop drawing.

The normal-session worker reported `restrictedToken:false`, `threadDesktop:Default`,
`sessionId:1`, `inputDesktopAccessible:false`, `errors.inputDesktop:5`, and
`lockState:locked`. Thus removing the execution sandbox did not establish access
to the input desktop. The tests did not bypass this gate or attempt to unlock,
switch desktops, send input, or change any existing document.

## Real Paint acceptance remains pending

The added `tests/paint-observation-reliability.ps1` uses a persistent real MCP
connection, gates startup on the actual worker preflight, and creates only its own
disposable Paint process. Developer transport is used solely for fixture launch;
observations and drawing use the four public MCP tools. It records five successful
`both` observations with query metrics, verifies image mode returns `not_checked`,
and dispatches a seven-action flower followed by a screenshot. The first incomplete
observation stops the test rather than retrying the same scan.

Run after restoring a usable interactive desktop:

```powershell
ctest --preset core-only -R '^(native-desktop|native-provider-timeout|native-pointer-path|native-input-routing)$' --output-on-failure
./tests/paint-observation-reliability.ps1 -Executable ./build/core/Release/computer-pilot.exe -OutputDirectory out/paint-validation-fresh -WaitForVisualReview
```

With `-WaitForVisualReview`, inspect the printed `REVIEW_IMAGE` before creating the
printed `REVIEW_GATE` file. Inspect the final flower screenshot as well; dispatched
actions alone do not establish visual correctness. The script closes only the
Process object it created and keeps local screenshot/evidence files.

No Paint latency, successful flower rendering, or full interactive acceptance is
claimed in the absence of those measurements. The original reported Paint timeout
was not reproduced in a usable desktop during this validation session.

## Host installation

The main task updated the local MCP executable configuration and installed Skill
to the current workspace build, after preserving backups. A running MCP host still
needs to reconnect/reload to use these updates; this report does not claim an
already-running host was hot-updated. Validation above launched the built executable
directly through the persistent MCP test client.
