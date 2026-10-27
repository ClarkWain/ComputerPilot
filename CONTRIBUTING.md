# Contributing

Use C++20 and the checked-in CMake presets. Windows uses Visual Studio 2022; macOS 14+ uses Xcode/Clang with Objective-C++ for native APIs. Keep changes scoped,
update the operation documentation when changing a contract, and add regression
coverage for failure behavior as well as successful dispatch.

Run `ctest --preset core-only -LE interactive` for non-interactive checks on either supported platform.
Run tests labeled `interactive` only in an available desktop session: they create
fixture windows and may change focus or clipboard state.

Do not commit model weights, runtime DLLs, screenshots, credentials, machine paths,
personal task records or build output. Keep third-party notices intact. Report
results with their environment and avoid unsupported reliability claims.

Contributions are provided under the applicable project license; retain upstream
notices for adapted code. See docs/BUILDING.md for package and release validation.
