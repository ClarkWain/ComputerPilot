# DesktopPilot

DesktopPilot 是供 AI Agent 使用的 Windows / macOS 桌面操作程序，使用 C++20 / CMake 开发。Agent 读取窗口、控件和截图，提出操作意图；DesktopPilot 负责定位控件、恢复窗口焦点并执行。运行不需要 Node 或 Python。

核心能力是**应用语义操作**：例如 Agent 提交“画一个红色圆”，程序根据适合当前应用的 profile 完成选工具、设置填充、输入 RGB、绘制和提交。没有匹配 profile 时，仍可使用点击、文本输入、按键、拖动和连续鼠标路径。

## macOS

新增 macOS 14+ 原生通用后端：窗口枚举、Accessibility 控件读取与填写、ScreenCaptureKit 截图、键鼠输入和权限诊断，保持相同四工具 MCP 接口。macOS 暂不新增 Paint/Aseprite profile。锁屏时降级为后台诊断，界面批次暂停；解锁后须重新观察再继续，不自动重放。

```sh
cmake --preset core-only
cmake --build --preset core-only --parallel 4
ctest --preset core-only -LE interactive
./build/core/desktop-pilot doctor
```

运行前需在系统隐私设置授予实际启动器/程序「辅助功能」和「屏幕录制」权限；`ready:false` 时按诊断修正后重连。macOS 构建、MCP 配置、点坐标与 Retina 截图说明见 [macOS 接入](docs/MACOS.md)。下文 Paint 适配和 Windows 会话说明仅适用于 Windows 后端。

## v0.5.0 更新与升级

本版保留四工具 MCP 接口，强化 UIA 超时与 profile 证据处理，新增现代中文版 Paint 适配和受限的 Aseprite 热键/点击 profile。下载 [v0.5.0](https://github.com/ClarkWain/DesktopPilot/releases/tag/v0.5.0)，或按下方步骤从源码构建。

从 v0.4.0 升级时，MCP 工具名称保持不变；重启服务以使用新版程序和 profile。Aseprite 的固定坐标保存动作已移除；核心发行包不含 OCR，因此不会显示 OCR 菜单动作。

动作执行完成不代表画面正确。逐图形像素抽样方案已撤销；Agent 在批次后查看截图验收。小尺寸原生多边形仍有已知问题，实验中的扫描线绘法尚未集成为自动语义后端。完整变更见 [CHANGELOG](CHANGELOG.md)，验证范围见 [验证记录](docs/OPTIMIZATION-VALIDATION.md)。

## 小花 Replay

新增原生 CLI 动作回放入口，默认只校验；实际执行会新建空白 PNG 并在 macOS 中文“预览”里重画小花，不复用旧窗口/控件 ID，不覆盖原图。

```sh
./build/core/desktop-pilot replay --file examples/replays/flower-preview/replay.json
./build/core/desktop-pilot replay --file examples/replays/flower-preview/replay.json --mode run --output out/my-flower-replay
```

输出目录必须不存在；锁屏或中途失败即停止，不自动重试或续跑。见 [小花示例](examples/replays/flower-preview/README.md) 与 [Replay 格式](docs/REPLAY.md)。MCP 工具数量保持四个。

## 四个工具

| 工具 | 用途 |
|---|---|
| `list_windows` | 无参数列出全部窗口，Agent 根据标题/PID 辨认 `window_id` |
| `get_window_state` | 获取控件、截图，以及当前窗口匹配的 profile 和语义动作示例 |
| `execute_semantic` | 使用匹配的 profile 执行一项或一批应用语义动作 |
| `execute_batch` | 执行一项或一批基础键鼠、文本操作 |

**连接并判断环境 → 确定目标窗口 → 获取状态 → 选择合适的执行方式 → 获取新状态验收。**

不需要 Agent 维护状态编号或在每个动作前激活窗口，但仍须读取环境检查结果、确认目标和处理失败。程序启动和执行时检查桌面环境，执行输入时恢复目标焦点；被模态对话框阻挡时返回对话框信息。批次失败立即停止，不自动重放已完成动作。

## 快速开始

Windows x64 Release 解压后使用 `bin/desktop-pilot.exe`，需要 Microsoft Visual C++ 2015–2022 x64 Runtime。源码构建：

```powershell
cmake --preset core-only
cmake --build --preset core-only --parallel 4
pwsh -NoProfile -File examples/onboarding/start.ps1 -Task check
pwsh -NoProfile -File examples/onboarding/start.ps1 -Task form
```

`form` 创建自己的测试窗口，填写字段、点击 Apply 并核验结果，结束后关闭测试窗口。

**DesktopPilot 必须与目标软件在同一个 Windows 用户会话和输入桌面中运行。** 隔离桌面、锁屏或受限令牌可能使输入不可用。服务会返回原因和修复提示；同名桌面或截图成功不能证明输入可用。

在 MCP 客户端中配置真实程序路径：

```json
{"mcpServers":{"desktop-pilot":{"command":"C:/实际安装目录/bin/desktop-pilot.exe","args":["serve"]}}}
```

若 Agent 没有 MCP 接口，可以复用仓库附带的持久 PowerShell 客户端，见 [完整接入示例](docs/MCP.md)。安装或更新 Agent skill：

```powershell
pwsh -NoProfile -File skills/desktoppilot/scripts/install.ps1 -Update
```

安装 skill 不会自动注册 MCP。程序更新后重连服务，让客户端刷新工具列表。

## 语义操作：根据实际窗口选 profile

先调用 `get_window_state`，读取 `semantic.profiles`。只有匹配当前进程、窗口类、DPI、布局和关键控件的 profile 才出现在可用列表中。唯一匹配时可省略 `profile`；有多个时选择其中一个；没有匹配时先根据原因修正可恢复的窗口/缩放条件并重新观察，检查失败或无法适配时，用 `mode:image` 获取新截图并使用 `execute_batch`。显式传入 profile 也不能跳过匹配检查。

例如，在返回了经典中文版 Paint profile 的窗口内画两个圆：

```json
{
  "window_id":"从窗口列表返回的值",
  "actions":[
    {"action":"drawing.drawCircle","args":{"center":[80,80],"radius":24,"fill":[255,0,0],"stroke":{"color":[30,30,30],"width":1}}},
    {"action":"drawing.drawCircle","args":{"center":[150,80],"radius":24}}
  ]
}
```

以上是 `execute_semantic` 的参数。第二个圆不重复指定样式，沿用工具当前设置；同批次也会复用已经确认的控件定位。Agent 不必逐个点击颜色菜单或填写 RGB 输入框。

## 能力与边界

- 截图按需返回，整窗最长边 1600，默认 PNG（对模型宿主兼容性最好）；基础操作自动转换截图坐标，局部检查使用无损截图。确认宿主支持 WebP 时配置 `DP_IMAGE_FORMAT=webp` 以减少字节。
- Paint 的密集多边形会在最多一画布像素误差内去除冗余顶点并选择较长起始边。小多边形仍有部分绘制失败的已知案例，不能用于严格逐像素复刻。执行器报告动作执行情况；整批完成后由 Agent 查看截图，判断绘制结果和质量。
- 单击 control_id 时优先调用控件的 Invoke 能力；不支持才使用前台指针。仍需前台输入的路径自动恢复焦点，但不承诺任意后台绘图。模态弹窗和持续遮挡返回具体阻塞，不盲目重放。
- 内部 `app.launch` 对新建且唯一匹配 profile 的窗口应用 recommendedWindow 尺寸，并限制在工作区内；已有窗口观察时不自动调整。

- **经典简体中文 Paint**支持图形、文字、刷子选择和 PNG 另存；**现代中文 Paint**仅适配已验证的 11.2605.81.0、120 DPI、100% 缩放条件，支持选笔、RGB/笔宽、连续路径和填充。两者都不代表兼容所有 Paint 版本。
- **Aseprite v1.2.15 英文界面**在 120 DPI 下提供 stock 热键选工具/缩放与通用窗口点击；OCR 菜单动作仅在 OCR 构建并配置模型时开放。没有像素绘图或保存语义。其他应用使用基础操作。
- 语义匹配不等于成品验收。绘图派发成功不保证像素级尺寸或美术质量，提交按钮点成功也不代表网站任务完成。
- 核心版不含 AI 模型；视觉解析是可选构建能力，发行包不附带模型权重。
- 对外 MCP 只有上述四个工具，旧工具名不保留别名。底层原生 JSONL 协议供开发调试使用，日常 Agent 无需学习。

## 文档

- [Agent Skill：用途、通讯、完整任务与故障处理](skills/desktoppilot/SKILL.md)
- [MCP 接入与调用示例](docs/MCP.md)
- [工具参数参考（由程序生成）](docs/AGENT-API.md)
- [可运行入门示例](examples/onboarding/README.md)
- [语义 profile 适配](docs/SEMANTIC-PROFILES.md)
- [构建](docs/BUILDING.md)、[开发协议](docs/PROTOCOL.md)、[底层操作](OPERATIONS.md)

## 许可证

原创代码采用 [MIT](LICENSE)。第三方代码、模型及改编内容保留各自许可，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
