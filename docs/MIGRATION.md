# DesktopPilot → ComputerPilot

ComputerPilot is the public continuation of DesktopPilot. The cleaned source commit history, `main`, the experimental `refactor/node-orchestration` branch and tags v0.3.0/v0.4.0/v0.5.0 are retained. Renaming is an additional commit; historical commit IDs are not rewritten by this migration. Old tags still contain the original product name and original build configuration.

## Update installation references

| Before | ComputerPilot v0.6.0 |
|---|---|
| `desktop-pilot[.exe]` | `computer-pilot[.exe]` |
| MCP server configuration key `desktop-pilot` | `computer-pilot` (a client-side label) |
| `skills/desktoppilot` | `skills/computerpilot` |
| `DesktopPilot::Core/Desktop/Service` | `ComputerPilot::Core/Desktop/Service` |
| `DESKTOPPILOT_PROFILES_DIR` | `COMPUTERPILOT_PROFILES_DIR` |

Change your MCP command path and restart the connection. The public MCP tool names remain `list_windows`, `get_window_state`, `execute_semantic` and `execute_batch`.

For compatibility, the `desktop_pilot` C++ header directory, old CMake aliases, old profile-directory environment variable, `desktopPilot/desktopPreflight` metadata key and v1 `desktop-pilot-calls` journal identifier are retained. The new profile environment variable takes precedence when both are set. Old replay-owned `DesktopPilot-replay-*.png` checkpoint documents remain accepted; new documents use `ComputerPilot-replay-*.png`. The Windows input mutex keeps its historical identity so old and new executors still serialize their input.

Move existing run directories intact if needed. Recipe, document and checkpoint hashes must still match; renaming does not authorize modifying checkpoints or replaying unknown input. Existing permission grants may need to be renewed for the new executable/host path.

## Historical research branch

The orchestration branch is preserved with its original DesktopPilot naming and documentation. Its trusted JavaScript host and file workflow experiments are separate from the native v0.6.0 package. General GUI orchestration is not claimed as a completed release feature.

GitHub Issues, pull requests, Actions logs and Release attachments are hosting metadata, not Git commits. The new repository starts its own hosting records; historical version tags are preserved without republishing old binaries. The original private repository is retained.
