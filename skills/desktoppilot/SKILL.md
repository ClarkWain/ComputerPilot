---
name: desktoppilot
description: 使用 DesktopPilot 操纵 Windows 桌面软件，读取控件和截图，执行应用语义、填写表单、键鼠操作并验证结果。实际桌面操作时使用；解释软件用法或编辑代码时无需使用。
---

# 使用 DesktopPilot 操纵电脑

DesktopPilot 负责观察 Windows 窗口并派发操作；Agent 负责辨认目标、选择动作和验收结果。应用有匹配 profile 时优先使用语义动作，否则根据控件或截图使用基础输入。只能调用实际返回的动作，不借用其他应用或版本的 profile。

开始前确认：

- 要操作哪个应用、窗口和文档；
- 需要改变什么，什么结果才算完成；
- 用户是否要求保留窗口大小、禁止保存或使用指定工具。

## 工具与工作流程

公开 MCP 只有四个工具：

| 工具 | 用途 |
|---|---|
| `list_windows` | 列出窗口，确定目标 `window_id` |
| `get_window_state` | 读取控件、截图、匹配的 profile 和动作示例 |
| `execute_semantic` | 执行当前 profile 支持的应用动作 |
| `execute_batch` | 点击、填字、按键、拖动、连续移动或准备窗口 |

先明确任务对象和完成标准，再 **列窗 → 观察 → 执行 → 重新观察验收**。操作中出现未知界面、弹窗或失败时回到观察。批次回执只说明动作执行情况，不能代替业务结果或画面验收。

不要维护或传入 `state_id`。窗口和控件引用由服务管理，只在当前连接与最近观察中有效。

## 建立连接并检查环境

宿主已有四个 MCP 工具时直接使用，不自行管理 JSON-RPC 编号。初始化诊断如可见，检查实际 worker 的 `desktopPreflight.ready`；输入前服务还会再检查。看到 `ready:false` 或 `desktop_environment_not_ready`，按原因修正启动环境后重连，不重试点击。未看到初始化响应时也不能假定 `ready:true`。

常见环境原因：

| 原因 | 处理 |
|---|---|
| `desktop_mismatch`、`desktop_name_mismatch` | 使服务和目标程序处于同一用户会话、输入桌面 |
| `restricted_execution_token`、`job_ui_restrictions` | 改用宿主允许桌面输入的启动方式 |
| `session_locked`、`input_desktop_unavailable` | 恢复可用的交互会话 |
| 进程退出或 stdout 关闭 | 检查真实路径、退出状态和 stderr |

`ready:true` 只表示输入环境通过检查，不证明目标控件、坐标或任务结果正确。

没有 MCP 工具时，读取本 Skill 目录的 `installation.json`，确认 `executable` 和可选 `args` 指向现存文件。Node 便携包用 `runtime/node.exe` 启动同包的 `node/dist/src/index.js`；旧 C++ 包用 `desktop-pilot.exe serve`。保持一个服务进程，直到任务结束，不为每次调用重启。仓库的 `examples/onboarding/client.ps1` 是可选通讯客户端。安装 Skill 本身不会注册 MCP；找不到程序或连接时报告实际缺失条件。

`root` 相对 `installation.json` 所在目录解析；`executable:"node"` 用 `Get-Command node` 验证 PATH 中的运行时，路径形式的 executable 和入口 args 相对 root 解析并转换为绝对路径，不能依赖当前工作目录。手动复制 Skill 到其他目录后运行源仓库的 `scripts/install.ps1`，生成该机器的实际 root、command 和 args；静态提示不能自动找到搬迁后的源码。

自行实现 MCP 客户端时，按 UTF-8 JSON-RPC over stdio 完成 `initialize`、`notifications/initialized` 和 `tools/call`。正常结果读 `result.structuredContent`；`result.content` 仅用于请求的图片等内容，不重复解析成第二份结果。顶层 `error` 是协议错误，`result.isError:true` 是工具错误。详细握手和超时见 [通讯说明](references/protocol.md)。

自行实现客户端的最小消息顺序：

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-agent","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_windows","arguments":{}}}
```

`notifications/initialized` 没有回执。stderr 仅供诊断，不与 stdout 的 JSON-RPC 混读。语义动作可能执行数分钟，等待最终回执，不高频轮询。

DesktopPilot 必须和目标程序处于同一 Windows 用户会话和输入桌面，且允许输入。桌面名称相同、可以列窗或截图，都不能覆盖 `ready:false`。环境失败时可尝试只读列窗；已有目标可用 `get_window_state` 的 `activate:false, mode:"controls"` 做诊断，但不保证成功。修正环境后重连并重新获取引用。不要把原生 worker 的私有 JSONL 当作公开 MCP 接口。

## 找到窗口并观察

`list_windows` 不接收筛选参数，传 `{}`。根据真实标题、PID 和任务上下文选择目标；一个进程可有多个窗口，不能默认取第一项。若应用未打开，而任务包含启动，可用宿主已授权的启动能力打开实际程序后再列窗。

已取得可用 `window_id` 时复用它，不为了取 ID 重复枚举。新弹窗可能也是独立窗口；要依据返回的身份重新确认目标。

首次调用 `get_window_state {"window_id":"实际值"}`。默认 `mode:"controls"` 返回精简控件和语义信息；长文本或完整字段用 `detail:"full"`。需要画面时选 `mode:"image"`，同时需要控件和画面时选 `mode:"both"`。纯 image 模式跳过 UIA/profile 扫描，`semantic.status:"not_checked"` 不代表不支持语义。默认会尝试恢复目标焦点，但不会调整窗口大小。

连续观察同一窗口时可用 `change_mode:"delta"`：首次返回全量，此后只返回变化。完全相同时只返回 `change:{kind:"unchanged"}` 等最小字段；控件差异在 `controls.added/updated/removed`，未返回的字段沿用上次观察。更新项的 `set` 表示新值，`unset` 表示删除字段。未变控件的旧 `control_id` 在当前连接中仍可用于下一次基础操作。

截图内容不变时，增量结果省略 `capture` 和内联图片；局部变化可能返回 `capture.kind:"patch"`，用 `rect` 定位到 `frame` 大小的原图，`fullPath` 可按需读取完整新图。局部图不改变基础动作的完整画面坐标；大范围变化返回完整截图。观察参数、窗口几何或 worker 改变时会返回 `change:{kind:"full"}` 重新建立基线。要主动重新获取完整状态，使用默认 `change_mode:"full"`；Agent 不传状态编号。UIA 检查不完整时也返回全量，不据此推断控件消失。

按任务选观察方式：

| 任务 | 优先观察 |
|---|---|
| 找输入框、菜单项或检查字段值 | 默认 `controls` |
| 判断画布、布局、遮挡和实际绘制结果 | `image` |
| 需要同时核对控件身份与外观 | `both` |

`mode:"both"` 即使控件查询局部失败，也可能保留截图和检查错误；不要把空控件数组直接当作没有控件。

截图默认只给本机 `capture.path`，用图片查看能力打开文件；远程客户端不能读本机路径时传 `image_delivery:"inline"`，查看 MCP image 块。不要把 base64 当文本输出，也不能只见路径就声称看过图。完整窗口截图默认最长边 1600 像素；需要细节可请求 `region:{x,y,width,height}` 或调整 `max_edge`。截图缩小时，原图路径在 `capture.originalPath`。默认 PNG；宿主支持 WebP 时可在服务环境设置 `DP_IMAGE_FORMAT=webp`，但文件变小不等于图片 token 必然减少。

`region` 坐标是窗口相对物理像素，适合放大观察文字、小图标或细线。需要看到整窗布局时不要只看局部图。

辨认控件时结合 `name`、`role`、`value`、位置与截图，不把第一个 Edit 当作目标。`truncated:true` 表示列表不完整，不能据此判断控件不存在或唯一。自绘区域按实际截图定位。

禁用或屏幕外控件先确认如何使它可操作。控件名相同、角色相同的候选，要靠上下文继续辨认。

基础动作使用最近观察的 `coordinateSpace`：

| 观察方式 | 基础动作坐标 |
|---|---|
| 有截图 | `image_pixels`，直接用返回图片上的像素；程序映射缩放与裁剪 |
| 仅控件 | `window_relative_physical_pixels`，窗口相对物理像素 |

不要加屏幕偏移或自行乘 DPI 缩放倍数。控件 `bounds` 仍是窗口相对物理坐标；语义绘图坐标遵循 profile 的 `coordinates`，Paint 通常是画布像素。窗口布局变化、操作完成、worker 重启或引用失效后重新观察；`referencesInvalidated:true` 时先重新列窗。

截图可能被遮挡。若 `foreground:false`、激活失败或主窗口被模态弹窗阻挡，先查前台/弹窗身份，不把主窗口坐标发给弹窗，也不循环激活。

## 使用匹配的语义动作

在 `get_window_state` 的 `semantic.profiles` 中读取实际匹配项的 `id`、`coordinates` 和 `actions[].example`。只提交返回的动作及参数；唯一匹配时可省略 `profile`，多个匹配时指定返回的 ID。执行前会再次核验窗口和 profile。

```json
{
  "window_id":"实际值",
  "actions":[
    {"action":"drawing.drawCircle","args":{"center":[80,80],"radius":24,"fill":[255,0,0]}}
  ]
}
```

这是参数形状示例，仅在当前窗口确实返回相应动作时使用。一个稳定绘图组可放在同一语义批次；服务内部处理工具、颜色和控件复用。完成后获取新截图，检查位置、颜色、轮廓及任务要求。`verification:"scene_dispatched"` 仅表示派发结束。

没有匹配项时看 `semantic.unavailable.reasons`：窗口太窄、缩放不符、最小化或弹窗等条件可按任务许可修正，再观察；`dpi_mismatch` 不能靠调窗口宽度解决。`ui_inspection_incomplete` 只表示检查未完成，可用新截图进行基础操作，不要原样反复扫描。用户要求保持窗口大小时不得擅自调整。profile 文件及适配范围见安装根目录的 `profiles/` 和 `docs/SEMANTIC-PROFILES.md`。

常见的不匹配原因：

| 原因 | 下一步 |
|---|---|
| `toolbar_too_narrow` | 任务允许时扩大逻辑客户区，再观察 |
| 缩放控件不符 | 在应用中恢复 profile 要求的缩放，再观察 |
| `window_minimized` | 恢复窗口后重新观察 |
| `window_blocked` | 观察返回的弹窗，按任务处理 |
| `dpi_mismatch` | 使用支持该 DPI 的适配；不要改系统显示设置来伪装匹配 |
| `ui_inspection_incomplete` | 读取检查原因；用截图和基础动作继续 |

修正后要确认 profile 真的出现在 `semantic.profiles` 中。
显式传入 profile ID 也不能绕过匹配检查。
没有可用语义能力时，可根据新观察使用基础输入。

对绘图任务，先核对文档、画布、缩放、图层/选区和参考图构图。用户要求在软件中绘制时应操作该软件；导入预生成图片不等于在软件里画。像素绘画另读 [Aseprite 指南](references/aseprite.md)，普通表单任务无需读取。

需要闭合轮廓再填充时，若当前 profile 实际提供 `drawing.drawPolyline` 和 `drawing.fillAt`，可先画 `closed:true` 的路径，再在封闭区域内填充。
闭合和最终颜色仍须从截图确认。
新版与经典 Paint 的动作范围不同，只看当前 profile 返回的目录，不借用另一版本的文字、保存或形状动作。

## 没有适用语义动作时使用基础输入

`execute_batch` 的 `actions` 是数组，单个动作也如此。常用动作：

| type | 关键参数 |
|---|---|
| `click` | `control_id` 或 `point:{x,y}`；`count:2` 为双击 |
| `fill_text` | `control_id,text`；替换字段并回读 |
| `type_text` | `text`；向当前焦点输入，不清空旧值 |
| `press_keys` | `chord`，如 `Ctrl+A`、`Enter` |
| `drag` | `from:{x,y},to:{x,y}` |
| `move` | `points:[[x,y],...]`，可加 `hold:"left"` 连续绘制 |
| `prepare_window` | 单独批次传 `client_size:{width,height,unit:"dip96"}` |

优先用 `fill_text` 替换可读字段；仅在焦点明确时用点击、全选和 `type_text`。基础批次只合并无需中途判断新界面的动作。打开未知菜单或对话框后先观察，再发下一批。执行器不回滚已完成动作，批次后必须观察结果。

```json
{
  "window_id":"实际值",
  "actions":[
    {"type":"fill_text","control_id":"实际字段ID","text":"Hello DesktopPilot"},
    {"type":"click","control_id":"实际按钮ID"}
  ]
}
```

`move` 的点按当前 `coordinateSpace` 解释，按住键时首点按下、末点释放；只提供轨迹转折点即可。路径执行后检查应用实际采样的笔迹。每项的 `delay_ms` 是该动作开始前的等待，不是点间等待。

连续笔画示例：

```json
{
  "window_id":"实际值",
  "actions":[
    {"type":"move","points":[[100,200],[120,210],[150,205],[180,230]],"hold":"left"}
  ]
}
```

没有 `hold` 的 `move` 只移动鼠标。
多条不相连笔迹用多个动作，不把按下状态跨动作保留。
应用可能平滑或重新采样鼠标事件，所以输入路径与实际像素不必完全一致。

`prepare_window` 调整逻辑客户区尺寸；`layout.clientDip96` 是实测客户区逻辑大小，`size` 是窗口外框物理大小。只在任务需要且允许调整窗口时使用，并且它不能和点击、拖动混在同一批次。调整后重新观察，不沿用旧坐标。

## 一个浏览器任务的操作边界

例如要在已打开的浏览器搜索并读取结果：

1. `list_windows {}`，辨认目标浏览器窗口。
2. 用 `get_window_state` 确认当前窗口与地址栏。
3. 没有适用语义动作时，提交基础批次：

```json
{
  "window_id":"实际值",
  "actions":[
    {"type":"press_keys","chord":"Ctrl+L"},
    {"type":"type_text","text":"https://www.google.com/search?q=AI"},
    {"type":"press_keys","chord":"Enter"}
  ]
}
```

4. 再观察页面。加载中可以有界等待；不要重复发送搜索请求。
5. 根据真实页面辨认广告、摘要和自然结果，不能把控件数组顺序当作视觉顺序。
6. 只读到摘要就报告摘要；若需要正文，打开实际链接再观察。

该示例只展示何时结束基础批次，不代表已经获取搜索结果。

## 失败、恢复与验收

| 返回情况 | 处理 |
|---|---|
| `unknown_window`、`referencesInvalidated:true` | 重新列窗 |
| `state_required`、`geometry_changed`、`control_changed` | 重新观察和定位 |
| `window_blocked` | 用返回的 `blocking_window.window_id` 观察实际弹窗 |
| `profile_not_matched`、`profile_ambiguous` | 查看匹配原因或明确选择当前 profile |
| `desktop_environment_not_ready` | 修正会话、桌面或输入权限后重连 |
| 超时、断连、部分失败 | 先核验实际效果，再决定剩余动作 |

失败时读 `completed`、`failedIndex`、`dispatch`、`error` 或 `failure`。即使失败项的 `dispatch` 未知，也可能已经改变界面；不能直接重放整批。基础动作成功、字段回读成功或语义派发成功，分别都不等于业务提交或作品验收成功。相同原因没有新证据时不原样重试。更完整的故障表见 [排查说明](references/troubleshooting.md)。

例如“填写标题 → 点击 Apply”在第二步失败：

1. 先读取完成数和失败索引，确认哪些动作已有明确结果。
2. 重新观察字段与应用反馈。
3. 若标题和反馈都正确，停止操作。
4. 若标题正确但反馈明确未更新，只用新的观察执行剩余点击。
5. 结果仍不确定时继续有界观察或报告阻塞，不整批重填重提。

连接超时或被取消后，输入可能已经发生。
重建连接会使旧引用失效；重新列窗与观察实际效果，再决定剩余工作。
不要重用 RPC id 试图避免重复提交。

任务完成即停止操作。遵守用户关于保存、窗口大小和工具的要求；不要关闭未保存文档或覆盖现有文件。实际参数以当前 `tools/list` 和安装根目录 `docs/AGENT-API.md` 为准，Skill 示例不是额外功能声明。
