# Install ComputerPilot Core

Download an archive and `SHA256SUMS.txt` from [ComputerPilot Releases](https://github.com/ClarkWain/ComputerPilot/releases). The first public release is v0.6.0; older preserved tags describe DesktopPilot source snapshots and do not imply a new release archive.

## Verify the download

macOS:

```sh
shasum -a 256 ComputerPilot-macos-arm64-core.tar.gz
```

Windows PowerShell:

```powershell
(Get-FileHash .\ComputerPilot-windows-x64-core.zip -Algorithm SHA256).Hash.ToLowerInvariant()
```

Compare the result with the matching line in `SHA256SUMS.txt` from that release. Extract into a new directory. Keep the adjacent `profiles`, `docs`, `skills` and license files with the executable.

## Windows x64

Install Microsoft Visual C++ 2015–2022 x64 Runtime. Run `bin/computer-pilot.exe doctor` in the same interactive user session as the target application. Configure your MCP client to run the full executable path with the argument `serve`. Windows Core validates Replay recipes; it does not execute the macOS drawing recipe.

## macOS 14+, Apple Silicon

The initial archive contains an **arm64 command-line executable**, not a signed `.app` installer. **It is unsigned and has not been notarized by Apple.** Intel/universal release artifacts and Developer ID signing/notarization are future work.

Extract the archive, then run:

```sh
./ComputerPilot/bin/computer-pilot doctor
```

If Gatekeeper blocks the downloaded executable, follow macOS's explicit Open Anyway flow in System Settings → Privacy & Security after reviewing its source and checksum. Availability of this option depends on the system version and organizational policy. Source building is an alternative. Do not disable Gatekeeper globally. [Apple installation guidance](https://support.apple.com/102445)

Grant Accessibility and Screen Recording permission to the actual program or launching host in System Settings → Privacy & Security. Restart the MCP connection after changing permissions. The real MCP worker's initialization reports preflight readiness; a successful `doctor` in another process cannot replace that check. Use the [macOS guide](MACOS.md) for diagnosis.

## MCP configuration

```json
{
  "mcpServers": {
    "computer-pilot": {
      "command": "/absolute/path/ComputerPilot/bin/computer-pilot",
      "args": ["serve"]
    }
  }
}
```

On Windows use a full path to `computer-pilot.exe`. Restart the client connection after installing an update. Core needs no Node/Python runtime or model weights. [Full MCP guide](MCP.md)

## Optional agent skill

PowerShell 7 works on both supported systems:

```powershell
./skills/computerpilot/scripts/install.ps1
```

This installs the skill and a local path hint, not an MCP server or OS permissions. Restart the agent session to discover the new skill. Use `-SkillsDirectory` for a custom location and `-Update` to explicitly replace an existing installation. [Migration notes](MIGRATION.md)
