# DesktopPilot

DesktopPilot 是供 AI Agent 使用的 Windows 桌面操作程序，使用 C++20 / CMake 开发。Agent 读取窗口、控件和截图，提出操作意图；DesktopPilot 负责定位控件、恢复窗口焦点并执行。运行不需要 Node 或 Python。

核心能力是**应用语义操作**：例如 Agent 提交“画一个红色圆”，程序根据适合当前应用的 profile 完成选工具、设置填充、输入 RGB、绘制和提交。没有匹配 profile 时，仍可使用点击、文本输入、按键、拖动和连续鼠标路径。

## v0.4.0 更新与升级

本版将 MCP 接口统一为下面四个工具，加入应用 profile、连续鼠标路径、批次内样式和控件复用、桌面环境检查、焦点恢复，以及限制尺寸的 WebP 截图。下载 [v0.4.0](https://github.com/ClarkWain/DesktopPilot/releases/tag/v0.4.0)，或按下方步骤从源码构建。

从 v0.3.0 升级时，需要按 [MCP 文档](docs/MCP.md) 修改旧工具调用，更新 skill，并重启 MCP 服务、刷新工具列表；旧工具名不保留兼容入口。经典中文版 Paint 是当前提供的绘图 profile，不能直接套用于任意 Paint 版本或其他软件。

动作执行完成不代表画面正确。逐图形像素抽样方案已撤销；Agent 在批次后查看截图验收。小尺寸原生多边形仍有已知问题，实验中的扫描线绘法尚未集成为自动语义后端。完整变更见 [CHANGELOG](CHANGELOG.md)，验证范围见 [验证记录](docs/OPTIMIZATION-VALIDATION.md)。

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

先调用 `get_window_state`，读取 `semantic.profiles`。只有匹配当前进程、窗口类、DPI、布局和关键控件的 profile 才出现在可用列表中。唯一匹配时可省略 `profile`；有多个时选择其中一个；没有匹配时先根据原因修正可恢复的窗口/缩放条件并重新观察，确认无法适配后再使用 `execute_batch`。显式传入 profile 也不能跳过匹配检查。

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

- 截图按需返回，整窗最长边 1600，默认 WebP；基础操作自动转换截图坐标，局部检查使用无损截图。PNG-only 宿主配置 `DP_IMAGE_FORMAT=png`。
- Paint 的密集多边形会在最多一画布像素误差内去除冗余顶点并选择较长起始边。小多边形仍有部分绘制失败的已知案例，不能用于严格逐像素复刻。执行器报告动作执行情况；整批完成后由 Agent 查看截图，判断绘制结果和质量。
- 单击 control_id 时优先调用控件的 Invoke 能力；不支持才使用前台指针。仍需前台输入的路径自动恢复焦点，但不承诺任意后台绘图。模态弹窗和持续遮挡返回具体阻塞，不盲目重放。
- 内部 `app.launch` 对新建且唯一匹配 profile 的窗口应用 recommendedWindow 尺寸，并限制在工作区内；已有窗口观察时不自动调整。

- 内置 profile 目前只有**经典简体中文 Paint**，支持图形、文字、刷子选择和 PNG 另存为；不是所有 Paint 版本通用。见 [profile 条件和参数](docs/SEMANTIC-PROFILES.md)。
- Photoshop、Blender、Aseprite 等应用没有内置专用语义适配；可依据实际截图和控件使用基础操作。
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
