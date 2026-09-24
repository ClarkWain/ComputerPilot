# DesktopPilot MCP 接入

DesktopPilot 的 MCP 只提供四个工具：`list_windows`、`get_window_state`、`execute_semantic`、`execute_batch`。语义动作是优先执行方式，但取决于实际窗口是否有匹配 profile。完整操作教程见 [Skill](../skills/desktoppilot/SKILL.md)，精确 schema 见 [接口参考](AGENT-API.md)。

## 配置

```json
{"mcpServers":{"desktop-pilot":{"command":"C:/实际安装目录/runtime/node.exe","args":["C:/实际安装目录/node/dist/src/index.js"]}}}
```

将两个路径替换为真实路径。发行包内固定 Node 运行时会启动同会话原生 worker；源码开发可运行 `node node/dist/src/index.js`，worker 默认位于 `build/release/Release`，可用 `DP_NATIVE_EXE` 指定。服务必须和目标应用在同一个 Windows 用户会话、输入桌面中运行，不能从不允许输入的隔离环境启动。

初始化时实际 worker 执行桌面环境检查；Node 服务在初始化说明中携带 `desktopPreflight`，环境不可用时还会写入 stderr。输入前再次检查，不需要 Agent 另调环境工具。**连接成功不代表环境可用。** 宿主隐藏初始化说明时不能编造 ready:true，仍须处理执行器返回的 `desktop_environment_not_ready` 和诊断。启动诊断写 stderr；stdout 专用于 JSON-RPC。

## 四个工具的分工

| 工具 | 输入 | 输出 |
|---|---|---|
| list_windows | 无参数，arguments 为 `{}`；列出全部窗口 | windows 数组，每项 window_id/title/pid |
| get_window_state | window_id；mode 默认 controls；detail 默认 compact；image_delivery 默认 path；change_mode 默认 full；activate 默认 true；可选 max_edge、region | controls/both 返回控件与语义检查；image 只截图，semantic.status=not_checked；delta 只返回变化 |
| execute_semantic | window_id、actions；可选 profile ID | 所选 profile、完成数、验证情况；失败时附错误及可用截图 |
| execute_batch | window_id、actions | 完成数、字段回读情况；失败时 failedIndex、error |

`actions` 接受 1–256 项。单项和多项使用同一个入口。语义项是 `{action,args}`；基础项是 `{type,...}`。两者分别表达应用意图与基础输入，不把底层操作注册表暴露给 Agent。

`get_window_state` 返回当前匹配 profile 的动作示例，而不是把所有应用参数塞进工具 schema。执行语义前再做一次匹配：唯一匹配可自动选；多个必须明确选；零个不能执行；已适配应用优先修正返回的窗口宽度/缩放等条件并重新观察，无法适配或检查未完成时，根据新截图使用基础操作；显式指定也不能绕过条件。

窗口焦点、观察状态与控件引用校验由执行器负责。Agent 需要判断环境结果、明确目标、依据观察执行并验收；自动检查报错后不能继续发送动作。不传 `state_id`，不插入激活动作。`activate:false` 仅用于后台只读诊断。

`mode:image` 完全跳过 UI Automation 和语义发现，适用于画布验收及 UIA 故障后的基础操作。返回 `semantic.status:not_checked`，不能将空 profiles 解释成不兼容。截图默认只返回本机 `capture.path` 和尺寸等信息；需要 MCP 图片块时传 `image_delivery:"inline"`。`mode:both` 在可恢复的 UIA 查询失败时保留截图路径，错误放在 `inspection`；若 worker 被终止并返回 `referencesInvalidated:true`，先重新 `list_windows`，再使用新 window_id 截图。

`change_mode:"delta"` 按当前 MCP 连接、窗口和观察参数比较上一份完整观察。首次调用或观察模式、区域、分辨率、图片交付方式、窗口几何/DPI 变化时返回 `change:{kind:"full",reason}`；后续只返回有变化的 `window` 字段、`controls.added/updated/removed`、语义或检查状态。完全相同时仅返回 `status`、`window_id` 和 `change:{kind:"unchanged"}`。未返回的字段表示沿用上次结果；`updated[].set` 与 `unset` 分别表示字段更新和删除。截图内容相同则省略 `capture`，即使请求了内联图片也不附加 image 块。局部变化时 `capture.kind:"patch"` 返回变化区域图片、其在原图中的 `rect`、原图尺寸 `frame` 和可按需读取的 `fullPath`；大范围变化或无法可靠比较时返回完整新图。局部图不改变基础输入的完整画面坐标系。Agent 不传状态编号；需要重新同步时用默认 `change_mode:"full"`。UIA 检查不完整时返回全量并清除基线，不推断控件被移除。即使增量省略了未变控件，当前连接内这些 `control_id` 仍可用于下一次基础操作。

状态中的 `size` 仍是窗口外框物理像素；可测量时新增 `layout.clientDip96`、`layout.displayDpi`、`layout.dpiAwareness`。`clientDip96` 是按显示器有效 DPI 归一化的客户区大小，不能单独证明应用布局兼容；profile 仍要检查实际控件/画布。窗口几何或 DPI 在观察后变化会使基础输入失效。

观察阶段 profile 扫描的 worker 上限为 8 秒，普通控件扫描为 5 秒；内部 queryTimeoutMs 是遍历软预算，不能中断单次阻塞的 UIA 调用。进程隔离超时会失效该 worker 的引用，不自动重放输入。

UIA 按需初始化，使用 `IUIAutomation2` 配置并回读连接、事务超时（各 2000 ms），配置失败时明确报告 UIA 不可用，不阻断纯截图。它们是 [provider 单次请求超时](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_transactiontimeout)，不是整次查询的硬性 2 秒上限。语义批次仍有独立的 600 秒总预算；COM/进程故障最终由 worker 隔离处理。

## 调用方式

MCP 宿主直接调用四个工具，Agent 阅读返回值决定下一步。没有宿主时启动 `node node/dist/src/index.js` 或发行包的 `runtime/node.exe node/dist/src/index.js`，保持一个服务进程，用下节 JSON-RPC 协议通讯。

先 list_windows（空参数），辨认目标，再 get_window_state。基础操作用 execute_batch，例如一次连续笔画：

```json
{"window_id":"w1","actions":[{"type":"move","points":[[100,200],[120,210],[150,205]],"hold":"left"}]}
```

省略 hold 只移动；指定 left/right/middle 时在首点按下、沿路径移动并在末点松开。points 是 1–4096 个 `[x,y]`，按住时至少两点。坐标遵循最近观察的 coordinateSpace：有截图直接使用 image_pixels，仅 controls 使用窗口物理像素；程序自动映射截图缩放与裁剪偏移。语义画布坐标不受截图缩放影响。整条路径是一个动作，delay_ms 仅在动作前等待。

需要调整**已有窗口**时，先观察，再明确发送一次单独的 `prepare_window` 基础动作。`client_size` 为期望的 96-DPI 逻辑客户区；可选 `minimum_client_size` 允许屏幕空间不足时缩到最低值。该动作会改变窗口大小，之后必须重新观察；若最低值都放不下或应用拒绝尺寸，返回具体原因及实测值。普通 `get_window_state` 不自动调整窗口。

```json
{"window_id":"w1","actions":[{"type":"prepare_window","client_size":{"width":1200,"height":700,"unit":"dip96"},"minimum_client_size":{"width":1050,"height":600,"unit":"dip96"}}]}
```

截图默认 PNG、完整窗口最长边 1600，不为缩图调整用户窗口。需要更高或更低分辨率时，在 `get_window_state` 的 image/both 模式传 `max_edge`（1..32000，保持比例且不放大）；局部 region 默认保持原始像素并采用无损编码。PNG 兼容所有模型宿主；MCP 无图像格式协商，WebP 在部分宿主（例如经 Copilot 转发到 Claude）会被拒绝，故不作默认。缩小前文件由 originalPath 保留。确认宿主支持 WebP 时在 MCP 服务 env 设置 `DP_IMAGE_FORMAT=webp` 以减少字节；未协商的宿主格式支持无法自动推断。WebP 主要减少字节量，视觉 token 是否降低取决于模型与图片尺寸。

应用动作可以由匹配 profile 封装时，使用 execute_semantic，省去 Agent 管理工具和颜色等细节。先看返回的 profile id、coordinates、actions[].example，再填 `{window_id,profile?,actions:[{action,args}]}`。profile 的原理、文件协议和适配流程见 [语义协议](SEMANTIC-PROFILES.md)。

## 通讯协议

启动 Node MCP 入口。stdin/stdout 是 UTF-8、每行一条 JSON-RPC 2.0 消息。先发送 initialize 并等待响应，再发 notifications/initialized，然后 tools/list 或 tools/call：

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_windows","arguments":{}}}
```

工具数据只放在 `result.structuredContent`，`result.content` 不重复放入 JSON 文本；`get_window_state` 仅在 `image_delivery:"inline"` 时附加 image 项。`result.isError` 表示工具失败。附带 Call-Pilot 会将这种失败抛为异常；脚本用 try/catch/finally，或用 Send-Pilot 直接检查错误对象，不要在异常后自动重放整批。语义失败截图仍自动附带。JSON-RPC `error` 表示协议或未知工具错误。

保持服务进程，不跨重连复用 window_id/control_id。语义批次在本地执行到完成或失败才响应；原生调用上限 600000 毫秒，客户端超时应更长。附带客户端默认给语义调用 610000 毫秒。长基础批次可直接用 `Send-Pilot -TimeoutMs` 设置通讯超时。

`ping` 可用于连接存活检查；取消使用 `notifications/cancelled`，`params.requestId` 指向正在执行的 RPC。取消不回滚已发生的输入。超时或连接丢失后先检查应用结果，再决定剩余工作。当前附带客户端发生读取超时后不保证连接可继续复用，应关闭/重建并刷新引用；关闭连接不会回滚输入。

## 升级与开发

工具减少没有取消环境、目标唯一性与结果验收要求。完整的表单示例与局部恢复见 [Skill 第六、七节](../skills/desktoppilot/SKILL.md)。

旧工具名不保留兼容入口，包括 `computer_*`、`check_environment`、`execute_single`。升级程序并重连客户端，刷新 tools/list。仅修改文档不会更新运行中的旧进程。

`node/src/mcp/tools.json` 是唯一公开工具 schema 来源；`examples/onboarding/generate-reference.ps1` 生成参数文档。底层原生 JSONL 使用 operation/args，是私有协议，不是另一组 MCP 工具，日常无需学习。旧 C++ `agent-schema` 仅供迁移对照。
