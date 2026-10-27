# macOS 后端

支持 macOS 14 Sonoma 及以上，C++20 / Objective-C++，原生运行不依赖 Node、Python 或 PowerShell。构建需要 Xcode Command Line Tools（或完整 Xcode）、CMake 3.29+；非交互 MCP 测试使用 Python 3。默认 core-only 不包含模型。

## 构建与启动

```sh
cmake --preset core-only
cmake --build --preset core-only --parallel 4
ctest --preset core-only -LE interactive
./build/core/desktop-pilot doctor
./build/core/desktop-pilot serve
```

首次配置会下载校验过的 libwebp。离线或仅使用 PNG 时，配置加 `-DDP_WITH_WEBP=OFF`。Apple Silicon 与 Intel 使用本机编译器架构；本机验证记录不能代替另一架构的测试。已有 Windows 构建目录时，应先另选一个构建目录，例如 `cmake --preset core-only -B build/mac-core`，后续 build/ctest 使用相同目录。

MCP 配置（替换真实路径）：

```json
{"mcpServers":{"desktop-pilot":{"command":"/absolute/path/DesktopPilot/build/core/desktop-pilot","args":["serve"]}}}
```

四个公开工具与 Windows 相同。源码构建中可运行只读入门检查：

```sh
python3 examples/onboarding/macos-check.py ./build/core/desktop-pilot
```

该脚本只连接、读取初始化诊断和列窗口，不激活或修改窗口。Python 是示例客户端与测试的依赖，不是服务运行依赖。

## 权限与会话

在「系统设置 → 隐私与安全性」为实际执行程序或被系统归因的启动器（终端/MCP 宿主）授予「辅助功能」和「屏幕与系统音频录制」（部分系统称「屏幕录制」）。程序不会自动申请权限或弹出授权提示。修改权限、移动/替换可执行文件后，重启服务并重新检查。正常锁屏与解锁可保持服务运行，但恢复输入前必须重新观察。

`doctor` 检查自身进程，MCP 初始化检查真正执行动作的 worker。两者的权限归因可能不同，以当前连接返回的 `_meta["desktopPilot/desktopPreflight"]` 为准。`ready:false` 时停止输入，保留诊断原因；不能靠改坐标或重试点击解决。

| 原因 | 处理 |
|---|---|
| `accessibilityTrusted_required` | 为实际启动链授予辅助功能访问，重启连接 |
| `postEventAllowed_required` | 系统不允许进程发送输入事件；检查辅助功能授权与宿主执行环境 |
| `screenCaptureAllowed_required` | 授予屏幕录制权限并重启连接 |
| `consoleSession_required` / `sameUserSession_required` | 在目标应用所在的已登录图形用户会话启动 |
| `session_locked_or_unknown` | 解锁或恢复可用的控制台会话后重连 |
| `secure_input_enabled` | 系统处于 Secure Input；退出相应密码输入状态后重新检查 |

没有权限时，窗口标题或 Accessibility 内容可能不可读。窗口枚举成功不等于能够截图、激活或输入。诊断不会自动更改系统设置。

## 通用操作范围

- CoreGraphics 枚举窗口，Accessibility 读取控件、聚焦指定窗口、执行 AXPress 与 AXValue；填写后回读验证。没有 AXPress 的控件可按实际控件中心点击。不可编辑的控件返回错误。
- ScreenCaptureKit 截取可见屏幕区域，包括覆盖在目标上的其他窗口；不是被遮挡应用的后台渲染。多显示器画面按统一 Retina 比例合成，保留原始图像，返回图片最长边默认 1600 像素。
- CGEvent 发送 Unicode 文本、按键、点击、拖动和连续鼠标路径。`Cmd` / `Command` / `Meta` 映射 Command，`Option` / `Alt` 映射 Option，`Ctrl` 保持 Control。例如 `{"type":"press_keys","chord":"Cmd+A"}`。
- 启动和输入前检查权限、登录用户、锁屏与 Secure Input。窗口 sheet/模态阻塞时返回其窗口身份；不会向主窗口继续输入。已有窗口不会因观察被调整大小。
- 独立 worker 提供提供者超时、取消、重启与未知写入结果去重。worker 重启后必须重新枚举、观察；不自动重放动作。

**本阶段没有新增 macOS Paint/Aseprite 或其他应用 profile。** `execute_semantic` 仍保留协议入口，但只能使用实际匹配的已安装 profile；macOS 通用任务使用 `execute_batch`。

不支持依赖私有窗口 API 的应用识别，不提供任意后台输入保证，也不保证自绘控件具有 Accessibility 树。找不到唯一 AX 窗口时明确失败；可以用 `activate:false, mode:image` 读取诊断截图。输入仍要求可确认的目标焦点。

## 锁屏降级与恢复

当前提供锁屏降级，不提供经过验收的锁屏应用写入动作。初始化 preflight 保留 `ready:false`，另返回 `executionMode:background_only` 和能力分类：

- `capabilities.backgroundOperations`：环境/进程/显示器诊断、窗口列表与窗口元数据、本地图像分析（仍取决于对应模型后端是否可用）。它们不依赖前台输入；窗口信息本身仍可能受系统权限限制。
- `capabilities.lockedApplicationActions:[]`：没有应用写入动作通过锁屏实测，AXPress、AXValue、剪贴板访问和截图不会因此自动放行。
- `capabilities.interactive:false`：键鼠、窗口激活、控件扫描和截图暂停。不能把“后台服务仍运行”理解为“界面可操作”。

这些分类描述现有底层能力，没有新增 MCP 工具。MCP 中可用 `list_windows` 获取窗口列表及 `desktopContext`；其他后台诊断和图像处理仍通过已有 CLI/开发协议调用，不新增公开工具别名。

例如，基础批次第一步完成后锁屏，第二步尚未发送：

```json
{
  "status":"error",
  "code":"desktop_locked",
  "paused":true,
  "completed":1,
  "failedIndex":1,
  "remaining":2,
  "dispatch":"not_started",
  "failedActionOutcome":"not_started",
  "resumeRequiresObservation":true
}
```

如果锁屏发生在持续鼠标路径或分段文本输入期间，`dispatch` 为 `dispatched`、`failedActionOutcome` 为 `inspect_required`。路径会停止发送后续点，并尝试释放由该路径按下的鼠标按钮。已产生的效果不回滚，失败动作不能直接当成完全未执行。

正常锁屏无需重启服务。解锁后先 `get_window_state`，检查已有结果，再仅提交未完成动作。服务不会保存一个待重放的界面任务队列，也不会因解锁自动重放批次。没有重新观察就继续输入，会得到 `state_required` 或 `observation_required`。

执行器在空闲期间约每 100 ms 采样会话变化，动作边界也会重新检查。`desktopContext.generation` 在观察到锁屏、解锁、用户会话、权限或 Secure Input 变化时更新；它由程序管理，Agent 不传递也不维护。即使解锁后窗口几何完全相同，变化前的观察也失效。观测前后发生转换时，不会保存为可用输入依据。

检查和系统事件发送不具备原子性，采样也不保证捕获任意短暂转换。短按键序列与原生调用可能已经产生效果；程序明确报告未知/已派发结果，不能把这套机制当成锁屏通用控制保证。权限撤销或启动环境变化仍可能需要重启、重新枚举。

## 显式绘图回放

用户主动要求重复一个已定义流程时，可用原生 `replay` CLI，新建画布后重新定位控件并绘制。默认只校验，执行需 `--mode run` 和新输出目录；这与失败后自动重放不同。小花实例、格式和当前限制见 [Replay](REPLAY.md)。

## 坐标

macOS 原生窗口与 Accessibility 使用全局屏幕点坐标（points）。仅控件观察返回 `coordinateSpace:window_relative_points`，控件 bounds 相对目标窗口；截图观察返回 `image_pixels`。截图的 `bounds` 与 `windowBounds` 保持点坐标，`pixelsPerPoint` 表明原始 Retina 截图比例。缩略图/裁剪偏移和点到像素转换由公共执行层处理，Agent 不应自行乘 Retina 倍率。

`region` 也是窗口相对点坐标。跨屏幕不同缩放比例的合成截图采用所覆盖显示器中的最大像素比例；图形输入始终回到点坐标。窗口或控件几何变化后，必须重新观察。

## 验证

```sh
# 不向用户应用发送输入
ctest --preset core-only -LE interactive

# 只创建、操作、关闭自己的 Cocoa 表单窗口
ctest --preset core-only -L interactive
```

2026-10-27 已在本机 macOS 26.4 arm64 上实际通过原生与公开 MCP 两项交互测试，包含本机 Retina 裁剪坐标、指针点击和连续拖动；范围与未验证项见 [本机验收记录](MACOS-VALIDATION.md)。

交互测试需要已解锁会话、辅助功能与屏幕录制授权；不满足时以跳过报告。测试覆盖窗口定位、AX 文本回读、中文/emoji、Command 按键与 Unicode 输入回读、按钮执行、ScreenCaptureKit 截图、模态 sheet 阻塞和观察不改窗口几何。非交互测试覆盖锁屏能力分类、批次中断与恢复、旧观察失效、协议、UTF-8 文件传输、图像编解码、SHA-256、坐标映射、权限分类、worker 超时/取消恢复；不能将这些结果当成真实应用输入验收。

可用 CMake 打包 core 二进制：

```sh
cmake -DDP_BINARY_DIR=build/core -DDP_PACKAGE_DIR=out/dist/DesktopPilot-macos -P cmake/package.cmake
```

本阶段不提供签名/公证安装包。macOS 可选 LibTorch / OCR 依赖需自行配置匹配架构的原生库，现有 Windows bootstrap 脚本不能用于下载 macOS 库；这些可选推理后端不在本阶段验证范围内。

底层使用 Apple 的 [Accessibility API](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted) 与 [ScreenCaptureKit 截图 API](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)。
