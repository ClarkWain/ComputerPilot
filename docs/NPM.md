# npm distribution and publishing

The npm channel starts with ComputerPilot 0.6.1. It installs the native Core for Windows x64 or macOS 14+ arm64. The launcher needs Node.js 20+; the separate Skills CLI requires Node.js 22.20+.

## Install

```sh
npm install -g computerpilot
computer-pilot --version
computer-pilot info
computer-pilot mcp-config
# Codex configuration (TOML):
computer-pilot mcp-config --format toml
```

Copy the generated `mcpServers` entry into the MCP client and reconnect it. The entry uses an absolute native executable path, avoiding Windows `.cmd` launcher differences. `info` reports the executable and its resource directory. Commands such as `serve`, `doctor`, `capabilities` and `replay` are forwarded to the native program.

Installation does not edit client settings or grant OS permissions. The executor still needs the documented interactive session and, on macOS, Accessibility and Screen Recording permission. macOS binaries remain unsigned and not notarized. See [installation](INSTALLATION.md).

Install the agent skill globally for Codex:

```sh
npx skills add ClarkWain/ComputerPilot --skill computerpilot -a codex -g -y
```

Omit `-g` for a project install; omit `-a codex` to choose another supported agent. The skill is also included in the npm entry package. Installing it supplies instructions, not an MCP connection or executable. See [Vercel Skills CLI](https://github.com/vercel-labs/skills).

## Packages

| Package | Contents |
|---|---|
| `computerpilot` | JavaScript launcher and agent skill |
| `computerpilot-win32-x64` | Windows native Core, resources and licenses |
| `computerpilot-darwin-arm64` | macOS arm64 native Core, resources and licenses |

Native packages are exact-version optional dependencies with `os`/`cpu` restrictions. npm selects the appropriate one and verifies tarball integrity. No installation scripts or runtime downloads are required; installation works with `--ignore-scripts`. All versions match `CMakeLists.txt`.

| Problem | Action |
|---|---|
| E404 from npm | That version has not been published. Use a [native release archive](https://github.com/ClarkWain/ComputerPilot/releases) until publishing is complete. |
| Missing native package | Reinstall without `--omit=optional` or `--no-optional`. |
| Native version mismatch | Reinstall/update the entry package and its dependencies together. |
| PowerShell blocks a generated `.ps1` shim | Use `npm.cmd` / `computer-pilot.cmd`; the generated MCP configuration launches the `.exe` directly. |
| `ready:false` | Follow the native preflight diagnostic; installing a skill does not fix session/permission problems. |

## Local validation

Build and package Core first, then run:

```sh
npm test
npm run prepare:npm -- --core out/npm-core --platform win32-x64 --out out/npm
npm run smoke:npm -- --packages out/npm
npm run test:skills
```

`out/npm-core` is the directory produced by `cmake/package.cmake`; see [building](BUILDING.md). On macOS use `--platform darwin-arm64`. On Windows PowerShell use `npm.cmd` when forwarding `--` options. The smoke test creates a temporary local registry and global prefix (including spaces), verifies platform selection and command shims, and negotiates the four-tool MCP protocol. It never changes user-global npm installs or agent skills. The Skills CLI check installs into a temporary project.

## First publication

Publish a matching native GitHub release first. The existing release workflow uploads both archives and `SHA256SUMS.txt`. Prepare npm packages from those exact, checksum-verified artifacts:

Linux maintainers need `libarchive-tools` (`bsdtar`) to read the Windows ZIP; the publishing workflow installs it. Windows and macOS already provide a compatible archive reader.

```sh
gh release download v0.6.1 --dir release-assets --pattern 'ComputerPilot-*-core.*' --pattern SHA256SUMS.txt
npm run prepare:npm -- --assets release-assets --out out/npm-release
npm run publish:npm -- --packages out/npm-release
```

The last command is a dry run. Sign into an npm account permitted to publish these names, then explicitly publish:

```sh
npm login
npm run publish:npm -- --packages out/npm-release --publish
```

Native packages are published first, the entry package last. A retry skips an existing version only when its published integrity matches the prepared tarball. Different contents require a new version. Credentials and generated packages stay outside Git.

The source workspace is marked `private` to prevent accidentally publishing the entry package by itself. The preparation command creates the three publishable directories with the correct manifests.

## Subsequent releases

Configure each package's npm Trusted Publisher for owner `ClarkWain`, repository `ComputerPilot`, workflow filename `npm-publish.yml`, and authorize direct `npm publish`. In GitHub Actions select the published tag in **npm packages**. It defaults to a dry run; clear `dry_run` to publish with OIDC and provenance. This requires npm CLI 11.5.1+ and Node.js 22.14+ on a GitHub-hosted runner; the workflow uses Node.js 24. No long-lived npm token is needed. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
