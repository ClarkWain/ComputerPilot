# ComputerPilot MCP 接入

macOS 的配置、权限诊断和坐标说明见 [macOS 接入](MACOS.md)。其公开工具与 Windows 相同，程序路径为无 `.exe` 后缀的 `computer-pilot`。

ComputerPilot 的 MCP 只提供四个工具：`list_windows`、`get_window_state`、`execute_semantic`、`execute_batch`。语义动作是优先执行方式，但取决于实际窗口是否有匹配 profile。完整操作教程见 [Skill](../skills/computerpilot/SKILL.md)，精确 schema 见 [接口参考](AGENT-API.md)。

## 配置

```json
{"mcpServers":{"computer-pilot":{"command":"C:/实际安装目录/bin/computer-pilot.exe","args":["serve"]}}}
```

将路径替换为真实路径。源码构建位于 `build/core/Release`，发行包位于 `bin`。服务必须和目标应用在同一个 Windows 用户会话、输入桌面中运行，不能从不允许输入的隔离环境启动。

初始化自动检查实际 worker 环境，结果在 `_meta["desktopPilot/desktopPreflight"]`。执行时还会检查，不需要 Agent 另调环境工具。**连接成功不代表环境可用。** 附带 Open-Pilot 只保存初始化响应，不会因 ready:false 自动抛错。调用方须判断 ready 是布尔 true；false 或诊断缺失时停止输入，按 reasons/nextAction 修正启动环境并重连。宿主隐藏初始化响应时不能编造 ready:true，仍须处理执行器返回的环境错误。启动诊断写 stderr；stdout 专用于 JSON-RPC。

macOS 的 `ready:false` 同时返回 `executionMode:background_only` 与具体能力分类。当前没有锁屏应用写入动作通过实测；窗口列表/元数据等诊断可继续。界面批次遇到锁屏返回 `paused:true`、`completed`、`failedIndex` 和 `resumeRequiresObservation:true`。正常解锁无需重启服务，但必须重新 `get_window_state` 并检查失败动作是否部分完成，再仅提交剩余动作；服务不自动重放。详见 [锁屏降级与恢复](MACOS.md#锁屏降级与恢复)。

显式动作回放由 `computer-pilot replay` CLI 提供，不是第五个 MCP 工具。它使用新画布和新观察执行已定义的流程；失败后仍不会自动重放。见 [Replay](REPLAY.md)。

## 四个工具的分工

| 工具 | 输入 | 输出 |
|---|---|---|
| list_windows | 无参数，arguments 为 `{}`；列出全部窗口 | windows 数组，每项 window_id/title/pid |
| get_window_state | window_id；mode 默认 controls；activate 默认 true；可选 region | controls/both 返回控件与语义检查；image 只截图，semantic.status=not_checked |
| execute_semantic | window_id、actions；可选 profile ID | 所选 profile、完成数、验证情况；失败时附错误及可用截图 |
| execute_batch | window_id、actions | 完成数、字段回读情况；失败时 failedIndex、error |

`actions` 接受 1–256 项。单项和多项使用同一个入口。语义项是 `{action,args}`；基础项是 `{type,...}`。两者分别表达应用意图与基础输入，不把底层操作注册表暴露给 Agent。

`get_window_state` 返回当前匹配 profile 的动作示例，而不是把所有应用参数塞进工具 schema。执行语义前再做一次匹配：唯一匹配可自动选；多个必须明确选；零个不能执行；已适配应用优先修正返回的窗口宽度/缩放等条件并重新观察，无法适配或检查未完成时，根据新截图使用基础操作；显式指定也不能绕过条件。

窗口焦点、观察状态与控件引用校验由执行器负责。Agent 需要判断环境结果、明确目标、依据观察执行并验收；自动检查报错后不能继续发送动作。不传 `state_id`，不插入激活动作。`activate:false` 仅用于后台只读诊断。

`mode:image` 完全跳过 UI Automation 和语义发现，适用于画布验收及 UIA 故障后的基础操作。返回 `semantic.status:not_checked`，不能将空 profiles 解释成不兼容。`mode:both` 在可恢复的 UIA 查询失败时保留截图，错误放在 `inspection`；若 worker 被终止并返回 `referencesInvalidated:true`，先重新 `list_windows`，再使用新 window_id 截图。

观察阶段 profile 扫描的 worker 上限为 8 秒，普通控件扫描为 5 秒；内部 queryTimeoutMs 是遍历软预算，不能中断单次阻塞的 UIA 调用。进程隔离超时会失效该 worker 的引用，不自动重放输入。

UIA 按需初始化，使用 `IUIAutomation2` 配置并回读连接、事务超时（各 2000 ms），配置失败时明确报告 UIA 不可用，不阻断纯截图。它们是 [provider 单次请求超时](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_transactiontimeout)，不是整次查询的硬性 2 秒上限。语义批次仍有独立的 600 秒总预算；COM/进程故障最终由 worker 隔离处理。

## 调用方式

MCP 宿主直接调用四个工具，Agent 阅读返回值决定下一步。没有宿主时启动 `computer-pilot.exe serve`，保持一个进程，用下节 JSON-RPC 协议通讯；也可选用 `examples/onboarding/client.ps1` 的 Open-Pilot / Call-Pilot / Close-Pilot，不要求 Agent 使用 PowerShell。

先 list_windows（空参数），辨认目标，再 get_window_state。基础操作用 execute_batch，例如一次连续笔画：

```json
{"window_id":"w1","actions":[{"type":"move","points":[[100,200],[120,210],[150,205]],"hold":"left"}]}
```

省略 hold 只移动；指定 left/right/middle 时在首点按下、沿路径移动并在末点松开。points 是 1–4096 个 `[x,y]`，按住时至少两点。坐标遵循最近观察的 coordinateSpace：有截图直接使用 image_pixels，仅 controls 使用窗口物理像素；程序自动映射截图缩放与裁剪偏移。语义画布坐标不受截图缩放影响。整条路径是一个动作，delay_ms 仅在动作前等待。

截图默认 PNG、最长边 1600，不为缩图调整用户窗口。PNG 兼容所有模型宿主；MCP 无图像格式协商，WebP 在部分宿主（例如经 Copilot 转发到 Claude）会被拒绝，故不作默认。局部 region 为窗口相对物理像素，采用无损编码；缩小前文件由 originalPath 保留。确认宿主支持 WebP 时在 MCP 服务 env 设置 `DP_IMAGE_FORMAT=webp` 以减少字节；未协商的宿主格式支持无法自动推断。WebP 主要减少字节量，视觉 token 是否降低取决于模型与图片尺寸。

应用动作可以由匹配 profile 封装时，使用 execute_semantic，省去 Agent 管理工具和颜色等细节。先看返回的 profile id、coordinates、actions[].example，再填 `{window_id,profile?,actions:[{action,args}]}`。profile 的原理、文件协议和适配流程见 [语义协议](SEMANTIC-PROFILES.md)。

## 通讯协议

启动 `computer-pilot.exe serve`。stdin/stdout 是 UTF-8、每行一条 JSON-RPC 2.0 消息。先发送 initialize 并等待响应，再发 notifications/initialized，然后 tools/list 或 tools/call：

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_windows","arguments":{}}}
```

工具输出是 `result.structuredContent`，`result.isError` 表示工具失败。附带 Call-Pilot 会将这种失败抛为异常；脚本用 try/catch/finally，或用 Send-Pilot 直接检查错误对象，不要在异常后自动重放整批。MCP 图片位于 `result.content`；语义失败截图会自动附带，无需 includeImage 参数。JSON-RPC `error` 表示协议或未知工具错误。

保持服务进程，不跨重连复用 window_id/control_id。语义批次在本地执行到完成或失败才响应；原生调用上限 600000 毫秒，客户端超时应更长。附带客户端默认给语义调用 610000 毫秒。长基础批次可直接用 `Send-Pilot -TimeoutMs` 设置通讯超时。

`ping` 可用于连接存活检查；取消使用 `notifications/cancelled`，`params.requestId` 指向正在执行的 RPC。取消不回滚已发生的输入。超时或连接丢失后先检查应用结果，再决定剩余工作。当前附带客户端发生读取超时后不保证连接可继续复用，应关闭/重建并刷新引用；关闭连接不会回滚输入。

## 升级与开发

工具减少没有取消环境、目标唯一性与结果验收要求。完整的表单示例与局部恢复见 [Skill 第六、七节](../skills/computerpilot/SKILL.md)。

旧工具名不保留兼容入口，包括 `computer_*`、`check_environment`、`execute_single`。升级程序并重连客户端，刷新 tools/list。仅修改文档不会更新运行中的旧进程。

`agent-schema` 导出同一份工具 schema；`examples/onboarding/generate-reference.ps1` 生成参数文档。底层 `jsonl` 是开发协议，使用 operation/args，不是另一组 MCP 工具，日常无需学习。
