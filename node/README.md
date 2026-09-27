# DesktopPilot Node entry

The Node entry exposes the four public MCP tools over stdio. It starts a private `desktop-pilot-native.exe` worker in the same Windows user session. Use Node.js 22 or newer for development. The release package should bundle a fixed Node runtime rather than depend on a user's global installation.

The first Replay CLI is documented in [docs/guides/REPLAY.md](../docs/guides/REPLAY.md). It validates and exports `.dpreplay` files without desktop input, drafts recipes from opt-in semantic recordings, and plays fixed semantic steps when the target desktop is available.

The file-batch Workflow preview is documented in [docs/guides/WORKFLOW.md](../docs/guides/WORKFLOW.md).
After building, run `node node/dist/src/workflow/cli.js plan <workflow.json>` from the repository root to preview the input snapshot. `run` creates its own fresh frozen plan; it does not consume the printed preview.
The initial adapter exports single-frame Aseprite files through its background CLI. Runs keep item results,
verification evidence, isolated candidate outputs, and a durable journal; uncertain items require reconciliation.
Optional trusted JavaScript makes item-level export/skip decisions. This preview does not promise arbitrary
JavaScript continuation recovery or general GUI workflow support, and adds no public MCP tools.

The separate [general orchestration development CLI](../docs/guides/ORCHESTRATION.md) runs trusted async
JavaScript with durable host commands, cross-window semantic/basic actions, questions and recovery.
Its cross-application path has simulated integration coverage; real GUI business acceptance remains open.

`get_window_state` supports opt-in `change_mode:"delta"`. The first observation returns full state; subsequent calls for the same window and view return changed controls, semantic data and screenshots only. An unchanged image does not produce an inline MCP image. Small visual changes return a positioned image patch and a full-size path for optional inspection; large changes return the full image. Input coordinates remain relative to the full observation frame. The server owns the baseline, so callers do not send a state ID. The default remains `change_mode:"full"` for existing clients.

## Development

From the repository root:

```powershell
npm ci --prefix node
npm run build --prefix node
node node/dist/src/index.js
```

Build the native target first. In a source checkout, set `DP_NATIVE_EXE` to `build/release/Release/desktop-pilot-native.exe` (or the absolute path to your build's worker); in a packaged layout the entry finds `native/desktop-pilot-native.exe`. Profiles load from the repository or package root `profiles/` directory. Override these absolute paths with `DP_NATIVE_EXE` and `DP_PROFILES_DIR` when needed. `DP_IMAGE_FORMAT=webp` opts in to WebP captures; otherwise captures use PNG. Standard output is reserved for MCP JSON-RPC; diagnostics go to standard error.

Both processes must run in the target application's interactive Windows session and input desktop. The native hello response checks this at startup, and the worker checks again before desktop input. `ready:false` requires correcting the launch context.

Create a complete Windows x64 validation bundle from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-node.ps1
```

The script uses a fixed Node.js 22.15.0 archive, verifies its official SHA-256, installs dependencies from `node/package-lock.json`, compiles TypeScript, and installs only production dependencies into a fresh bundle. It requires the native worker, its WebP notices, both verified PP-OCRv4 models, and the converted OmniParser ONNX plus provenance manifest. Missing or mismatched inputs fail packaging; the bundle is never published partially. The default source paths can be changed with `-NativeExe`, `-WebpLicenseDir`, `-DetectorOnnx`, `-NodeArchive`, and `-OutputDir`. A pre-existing output directory is rejected. The script then runs `smoke.mjs` with the bundled Node binary, checks every bundled file's hash, loads both model families, negotiates the four MCP tools, calls read-only `list_windows`, and completes a no-desktop orchestration run and resume from outside the source checkout.

The distribution layout is:

```text
app/
  runtime/node.exe
  desktop-pilot-mcp.cmd
  desktop-pilot-replay.cmd
  desktop-pilot-orchestration.cmd
  REPLAY.md
  ORCHESTRATION.md
  node/dist/src/index.js
  node/node_modules/
  native/desktop-pilot-native.exe
  profiles/<profile-id>/profile.json
  models/ocr/{det,rec}.onnx
  models/icon_detect_v3/model.onnx
  models/icon_detect_v3/model.onnx.manifest.json
  licenses/
  bundle-manifest.json
  smoke.mjs
```

Configure MCP with the absolute paths to `runtime/node.exe` as the command and `node/dist/src/index.js` as its argument (see `mcp.example.json`). Directly supervising the Node process lets the host close the native worker when MCP stdin ends. `desktop-pilot-mcp.cmd` is available for manual console use. Run `runtime/node.exe smoke.mjs` from the package directory after copying it to another Windows x64 machine. A desktop input operation still requires an interactive user session.

Node handles PP-OCRv4 and converted OmniParser ONNX inference. The original `.pt` model is not shipped; pass the packaged `.onnx` path directly to the private `vision.parse` operation. The conversion command, parity measurements, and remaining OCR limitations are recorded in the source repository's `docs/design/NODE-VISION-MIGRATION.md`. Node and ONNX Runtime notices are copied to `licenses/`; each installed npm package retains its own license file under `node/node_modules/`. OmniParser model redistribution requires a review of the exact weight license notice described in `THIRD_PARTY_NOTICES.md` before publishing a bundle to third parties. This bundle is currently an internal validation artifact; the repository's public launcher has not switched to Node.
