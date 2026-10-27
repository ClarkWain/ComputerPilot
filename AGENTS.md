# DesktopPilot contributor and agent entry

For desktop tasks read skills/desktoppilot/SKILL.md. The public MCP API has exactly four tools: list_windows, get_window_state, execute_semantic, execute_batch. Discover the actual window, inspect it, prefer a matching semantic profile, otherwise use basic input, then inspect the result. No legacy MCP aliases or agent-managed state_id.

The executor must share the application's interactive user session and permit input (Windows input desktop; macOS console session with Accessibility/Screen Recording permission). Startup and execution check this automatically; ready:false means inspect the reasons, not retry clicks. macOS allows only listed background diagnostics while locked; no application writes are lock-screen validated. After unlock, reacquire an observation before submitting only unfinished actions; never replay a paused batch automatically. State reads and input recover focus automatically. Modal blockers are reported with their window identity. Do not resize user windows without a task reason.

Profiles are chosen from current executable, window class, DPI, layout and UI evidence. Never hardcode the Paint profile for another application. Keep action examples with each manifest; execute_semantic revalidates matches and preserves batch reuse. Do not describe proposed Aseprite semantics as implemented.

Code-only work need not operate the desktop. Preserve unrelated changes. Build core with CMake presets and run ctest --preset core-only -LE interactive. Interactive demos create disposable windows; preserve existing documents.

MCP schema has one source: AgentApi::tools() in src/agent_api.cpp. Export with agent-schema; regenerate docs/AGENT-API.md using examples/onboarding/generate-reference.ps1. Update docs/examples/tests together. Raw JSONL operations are internal/developer facilities, not more MCP tools.
