ComputerPilot v0.6.1 — npm and Skills CLI installation.

This update adds npm distribution and a discoverable agent skill while preserving the native four-tool MCP API.

## Highlights

- Install the native command with `npm install -g computerpilot` once the matching npm packages are published. Generate client configuration with `computer-pilot mcp-config`.
- Install the skill with `npx skills add ClarkWain/ComputerPilot --skill computerpilot -a codex -g -y`.
- Windows model-free Core now statically links the Visual C++ runtime.

- Native Windows/macOS engine with exactly four MCP tools: discover windows, observe, execute semantic actions, and batch basic inputs.
- Implemented classic Chinese Paint semantics and restricted modern Paint/Aseprite profiles; matched application/version/DPI/layout conditions apply.
- Opt-in call recording and macOS PNG drawing Replay, offline export and checked checkpoint resume. Windows validates recipes; it does not execute macOS Replay.
- New ComputerPilot executable, skill, bilingual introduction, semantic diagrams, original Replay video/GIF and installation/migration documentation.
- Compatibility for existing v1 journals, replay-owned checkpoint names, C++ aliases and profile-directory configuration.

## Downloads

| Archive | Platform |
|---|---|
| `ComputerPilot-windows-x64-core.zip` | Windows x64; Visual C++ runtime linked statically |
| `ComputerPilot-macos-arm64-core.tar.gz` | macOS 14+, Apple Silicon; **unsigned and not notarized** |

Verify the archives against `SHA256SUMS.txt`, extract to a new directory, and configure your MCP client to run `bin/computer-pilot[.exe] serve`. Keep the adjacent profiles, documentation and license files. Core needs no Node/Python runtime or model weights.

See [Installation](https://github.com/ClarkWain/ComputerPilot/blob/main/docs/INSTALLATION.md), [MCP setup](https://github.com/ClarkWain/ComputerPilot/blob/main/docs/MCP.md) and [Migration](https://github.com/ClarkWain/ComputerPilot/blob/main/docs/MIGRATION.md).

## Execution boundaries

Use an unlocked interactive session; on macOS grant Accessibility and Screen Recording permission to the actual executable or launching host. A successful input receipt requires final application/result inspection. Unknown or partially dispatched input is never automatically replayed.

macOS uses generic controls and basic input, without added Paint/Aseprite profiles. Aseprite pixel drawing and save semantics are not included. General orchestration remains on the historical research branch and is not part of these Core packages. Intel/universal macOS packages and Developer ID signing/notarization are future work.

Original project code is MIT licensed; adapted code and third-party components retain their notices. No model weights are bundled.
