# Security and data handling

ComputerPilot can observe application content and send native input as the OS account running it. Use trusted MCP clients and trusted local configuration. The current public transport is local MCP stdio; this release does not provide a network authentication service or a sandbox for untrusted agents.

## Reporting a vulnerability

Report security issues privately to **eieihihi@outlook.com**. Include the affected version, platform, a minimal reproduction and the likely impact. Redact credentials and personal documents. Please avoid posting an exploit or sensitive logs in a public issue before a fix is available. The latest public release is the supported version; response times are not guaranteed.

## Session and execution boundaries

The executor and target application must share an interactive user session. On macOS, Accessibility and Screen Recording permissions are required. Locking pauses application input; only listed background diagnostics remain available. Unlocking requires a fresh observation and an explicit decision about unfinished work. Never replay an uncertain or partially dispatched batch blindly.

Profiles are application adapters, not a security boundary. A successful input receipt is not proof that the intended business operation succeeded. Inspect the application result before proceeding with consequential work.

## Local data

- Observations and diagnostic screenshots may contain visible document content and are written to local temporary/output directories. Do not assume they are automatically erased.
- Recording is opt-in and records ComputerPilot calls, which can include typed content and paths. It does not listen to global manual input. macOS recording directories/files are created with restricted owner permissions.
- Replay reports, checkpoint snapshots and recipes may contain document paths or content. Choose private output directories and redact evidence before sharing.
- The native core has no built-in cloud telemetry or model-service upload. Your MCP client controls what observations are forwarded to a model or another service.
- Optional dependency/model bootstrap downloads are separate from desktop execution. Core release archives do not bundle model weights.

Do not run untrusted recipes or orchestration JavaScript. The historical orchestration branch runs trusted code and has a separate experimental status; it is not part of the native Core release.
