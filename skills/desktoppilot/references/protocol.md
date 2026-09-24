# 通讯与引用

日常入口是四个公开 MCP 工具，完整教程见 [SKILL.md](../SKILL.md)。参数以当前 `tools/list` 为准；源码仓库的 `docs/AGENT-API.md` 可作补充参考。

## 没有 MCP 宿主时

从 skill 目录的 `installation.json` 读取 `executable` 和可选 `args`，确认路径存在。Node 便携包启动 `runtime/node.exe`，参数为同包的 `node/dist/src/index.js`；旧 C++ 发行包才用 `desktop-pilot.exe serve`。保持一个服务进程，通过 UTF-8 stdio 收发 JSON-RPC。Agent 可使用宿主已有的客户端能力，不需要为窗口判断复制固定脚本。

可选的 `<root>/examples/onboarding/client.ps1` 只简化通讯：Open-Pilot 建立连接并保存 Initialization，Call-Pilot 调用工具，Send-Pilot 保留工具错误对象，Close-Pilot 关闭服务。任务中复用同一个连接。客户端处理 UTF-8、握手、RPC 编号、stderr 消费及语义调用超时。

Open-Pilot 不会因 ready:false 自动终止；Agent 阅读初始化中的 desktopPreflight，确认环境可用后执行。Call-Pilot 遇到 isError:true 会抛异常；需要完整失败对象时使用 Send-Pilot。不要将异常当作空结果继续输入。

## 引用和输出

- `window_id`：当前连接返回的窗口标识。
- `control_id`：最近一次 get_window_state 返回的控件标识。
- 观察状态由程序维护，Agent 不传状态编号。
- 工具结果在 `result.structuredContent`；MCP 图片在 `result.content`。
- `semantic.profiles` 中的 profile 使用 ID，不使用文件路径；匹配多项时明确选择。
- `get_window_state` 返回 `coordinateSpace`：有截图时基础动作使用图片像素；仅控件时使用窗口相对物理像素。语义坐标以 profile 的 `coordinates` 为准。

原生 worker JSONL 属于私有平台协议，不接受公开四工具参数；日常使用 Node MCP 入口。旧 C++ 服务的离线文件传输每次启动都是新连接，不能复用旧引用。

更新二进制后重启 MCP 服务，刷新工具列表。旧工具名没有别名。

## 超时与证据

Send-Pilot 客户端超时后可能仍有未完成的 ReadLineAsync，不能假设连接还能正常匹配后续响应。结束/重建服务连接，重新获取窗口状态并确认实际效果，再决定剩余动作；重连不是重放的理由。原生取消和终止也不回滚已发生的输入。

测试时在首次运行中保存关键 structuredContent 与截图路径；向 Agent 只输出摘要。不要为补证据重新执行提交或绘图。只返回了截图路径不代表已经查看图片，须使用宿主图片查看能力读取实际结果。
