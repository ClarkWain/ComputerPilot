# 批次：减少逐步介入，保留结果验收

有匹配 profile 时优先 `execute_semantic`，由应用适配器处理控件、颜色和等待。没有适用语义时，`execute_batch` 一次提交稳定的基础动作序列。两者都只返回最终完成或失败结果，不需要 Agent 逐步轮询。

```json
{"window_id":"实际窗口ID","actions":[
  {"type":"click","point":{"x":100,"y":200}},
  {"type":"type_text","text":"示例","delay_ms":100},
  {"type":"press_keys","chord":"Enter"}
]}
```

这是 execute_batch 参数。坐标来自最近 get_window_state，基于窗口左上角的物理像素。delay_ms 是动作前的可选等待，默认 0；稳定本地界面无需额外停顿。字段替换优先 fill_text，让程序回读确认。

## 程序承担的检查

- 一次批次预先验证所有参数；执行时逐项恢复目标焦点。
- 原生输入再次检查窗口、尺寸和遮挡；参数错误不开始批次，运行中失败停止。
- 控件和窗口位置改变时返回错误，要求重新获取状态；模态弹窗返回其窗口标识。
- 内部维护观察状态，不向 Agent 暴露状态编号。已消费观察不能再次执行。
- 语义批次复用已确认的控件与工具样式，介入或界面变化时失效重查。

这些检查不是操作系统级事务；输入发出后仍需核验实际结果。未观察的新页面、弹窗不应靠旧坐标跨越。

## 回执与恢复

成功返回 completed，填写字段还返回 fieldsVerified。失败给出 failedIndex 和 error/failure，语义失败尽量附带局部截图。失败不回滚，未知结果不等于尚未发生；重新观察后只处理未完成部分。

MCP 不再提供第二套通用注册表批处理、fromStep、before/after 或独立等待工具。具体应用的条件检查应放在 profile 的原生适配器中。不要在四工具之上再让 Agent 学习一套流程语言。

详细参数见 [Agent API](docs/AGENT-API.md)，应用语义见 [Profiles](docs/SEMANTIC-PROFILES.md)。
