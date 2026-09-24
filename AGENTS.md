# DesktopPilot contributor and agent entry

For desktop tasks read skills/desktoppilot/SKILL.md. The public MCP API has exactly four tools: list_windows, get_window_state, execute_semantic, execute_batch. Discover the actual window, inspect it, prefer a matching semantic profile, otherwise use basic input, then inspect the result. No legacy MCP aliases or agent-managed state_id.

The executor must share the application's Windows user session/input desktop and permit input. Startup and execution check this automatically; ready:false means correct the launch context, not retry clicks. State reads and input recover focus automatically. Modal blockers are reported with their window identity. Do not resize user windows without a task reason.

Profiles are chosen from current executable, window class, DPI, layout and UI evidence. Never hardcode the Paint profile for another application. Keep action examples with each manifest; execute_semantic revalidates matches and preserves batch reuse. Do not describe proposed Aseprite semantics as implemented.

Code-only work need not operate the desktop. Preserve unrelated changes. Build the platform worker with the windows-release CMake preset and run ctest --preset windows-release -LE interactive; the former C++ service is available only through core-only or legacy-windows-release for migration comparison. Run Node tests with npm test --prefix node. Interactive demos create disposable windows; preserve existing documents.

MCP schema has one source: node/src/mcp/tools.json. Regenerate docs/AGENT-API.md and docs/agent-tools.schema.json using examples/onboarding/generate-reference.ps1. Update docs/examples/tests together. The old AgentApi::tools() belongs to the opt-in legacy comparison build. The native worker JSONL protocol is private and does not add public MCP tools.
