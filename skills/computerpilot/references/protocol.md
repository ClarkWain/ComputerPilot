# 通讯与引用

日常入口是 `serve` 的四个 MCP 工具，完整教程见 [SKILL.md](../SKILL.md)。参数表由程序生成，位于安装根目录 `docs/AGENT-API.md`。

## 没有 MCP 宿主时

从 skill 目录的 installation.json 读取实际安装根目录与程序位置。启动 `computer-pilot.exe serve`，保持进程，按根目录 docs/MCP.md 的 UTF-8 JSON-RPC 示例收发。Agent 自行选择已有通讯能力，不需要为窗口/控件判断复制固定 PowerShell 脚本。

可选的 `<root>/examples/onboarding/client.ps1` 只简化通讯：Open-Pilot 建立连接并保存 Initialization，Call-Pilot 调用工具，Send-Pilot 保留工具错误对象，Close-Pilot 关闭服务。任务中复用同一个连接。客户端处理 UTF-8、握手、RPC 编号、stderr 消费及语义调用超时。

Open-Pilot 不会因 ready:false 自动终止；Agent 阅读初始化中的 desktopPreflight，确认环境可用后执行。Call-Pilot 遇到 isError:true 会抛异常；需要完整失败对象时使用 Send-Pilot。不要将异常当作空结果继续输入。

## 引用和输出

- `window_id`：当前连接返回的窗口标识。
- `control_id`：最近一次 get_window_state 返回的控件标识。
- 观察状态由程序维护，Agent 不传状态编号。
- 工具结果在 `result.structuredContent`；MCP 图片在 `result.content`。
- `semantic.profiles` 中的 profile 使用 ID，不使用文件路径；匹配多项时明确选择。
- get_window_state 和 execute_batch 的坐标是窗口相对物理像素。语义坐标以 profile 的 coordinates 说明为准。

`serve --input/--output` 是离线文件传输，每次启动仍是新连接，不能复用旧引用。`jsonl` 子命令的 operation/args 属于底层开发协议；不要混用四工具的参数。

更新二进制后重启 MCP 服务，刷新工具列表。旧工具名没有别名。

## 超时与证据

Send-Pilot 客户端超时后可能仍有未完成的 ReadLineAsync，不能假设连接还能正常匹配后续响应。结束/重建服务连接，重新获取窗口状态并确认实际效果，再决定剩余动作；重连不是重放的理由。原生取消和终止也不回滚已发生的输入。

测试时在首次运行中保存关键 structuredContent 与截图路径；向 Agent 只输出摘要。不要为补证据重新执行提交或绘图。只返回了截图路径不代表已经查看图片，须使用宿主图片查看能力读取实际结果。
