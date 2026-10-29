# 协议与执行语义

ComputerPilot 提供三种入口：C++ 同步库、MCP JSON-RPC 2.0 stdio、原生 JSONL。日常 MCP 只有四个工具，见 [MCP.md](MCP.md)。下文主要描述原生开发协议，其操作参数以 capabilities/describe 和 OPERATIONS.md 为准。

## JSONL

```json
{"id":1,"operation":"window.list","args":{}}
```

运行 `computer-pilot.exe jsonl`，每行一个请求；`serve` 与 `jsonl` 均支持 `--input requests.jsonl --output responses.jsonl`。输入输出不得是同一文件。JSONL 直接调用同步后端，不具备 MCP 外层工作进程监督。

## 引用与坐标

- windowRef、elementRef、imageRef 为会话内不透明引用，不从 HWND 或其他进程的结果拼造。
- 工作进程重启后重新枚举；不要继续使用旧引用。
- screen_physical 使用虚拟屏幕物理像素。
- window_relative/client_relative 使用实时窗口/客户区原点，需要 windowRef。
- image_pixels 使用当前会话捕获的 imageRef，窗口几何改变会使映射失效。
- 相对输入可附 expectedSize（整个窗口物理像素宽高），防止移动自适应掩盖布局尺寸变化。

## 完成、失败和去重

派发成功不代表业务完成。检查 status、verification 和任务对应的业务状态。unknown 不能当作未执行。批次并非事务，失败停止但不回滚；失败项可能已经生效。

同一会话中，相同 requestId 与相同参数返回缓存回执；不同参数复用 ID 返回冲突。action.status 查询该 ID。父服务重启不保留缓存，不承诺持久 exactly-once。

## 超时与取消

MCP 单次基础 provider 默认超时 60 秒；语义执行配置为 600 秒。开发协议可用 providerTimeoutMs 调整。硬超时/取消可能终止工作进程，已经发生的输入不可回滚。notifications/cancelled 的 requestId 指 JSON-RPC 请求 ID；action.status 的 id 指动作去重 ID，两者不同。

## 输出

浮点数序列化最多四位小数并去尾零，不修改内部存储精度。它不是无损浮点传输协议。紧凑 UI 查询保留必要字段；批次默认返回完成摘要，失败保留步骤、阶段和分发尝试信息。原生 metrics 记录执行耗时，不代表 agent 总时长或 token 数。
