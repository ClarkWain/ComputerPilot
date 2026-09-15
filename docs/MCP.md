# MCP 接入

启动 `desktop-pilot.exe serve`，通过 stdin/stdout 交换每行一个 JSON-RPC 2.0 消息。运行进程的 Windows 会话决定它能看到和操作哪个桌面。

```json
{"mcpServers":{"desktop-pilot":{"command":"C:/tools/DesktopPilot/bin/desktop-pilot.exe","args":["serve"]}}}
```

## 初始化

客户端发送 initialize，等待响应后发送 notifications/initialized，再使用 tools/list。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example-client","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

## 工具

| 工具 | 用途 |
|---|---|
| computer_runtime | capabilities、describe、action.status、取消请求 |
| computer_query | 只读窗口、控件、会话或视觉操作 |
| computer_inspect | 读取状态，允许截图和混合检查 |
| computer_act | 执行一个操作，可设置 requestId |
| computer_batch | 顺序执行，引用前序结果，可选条件核验 |
| computer_wait | 在程序内部轮询只读条件 |

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"computer_query","arguments":{"operation":"window.list","args":{"titleContains":"Example"}}}}
```

返回 `structuredContent` 和等价文本内容；客户端应选择一种呈现，避免重复喂给模型。截图通过显式 `includeImage:true` 请求，不必每次附带。

窗口引用仅在当前服务/工作进程有效。筛选结果不唯一时继续缩小范围，不能直接盲选第一个窗口。先读 `system.session`，然后读取窗口和控件。字段填写优先 `ui.fill` 或 `ui.fill_form`；只有缺乏可用控件时才使用截图定位。

## 减少 agent 往返

使用 `ui.find` 的 `format:compact`，批次使用 `output:summary`，只有诊断时开启 metrics。把同一表单的填写及回读封装为一次请求；用 before/after 验证状态。未验证的长序列可能把一次失误放大为整批错误。

组合命令完整语义见 [BATCH-RELIABILITY](../BATCH-RELIABILITY.md)，字段参数见 [OPERATIONS](../OPERATIONS.md)，错误与取消见 [PROTOCOL](PROTOCOL.md)。
