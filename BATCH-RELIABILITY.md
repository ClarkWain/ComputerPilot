# 组合命令：绑定窗口、内部核验、精简回执

## 推荐调用方式

`computer_batch` 保持顺序执行。将窗口绑定和坐标系放入 `inputDefaults`，避免每步重复发送。先用当前会话返回的唯一 `windowRef` 激活目标，再执行输入批次。

```json
{
  "output": "summary",
  "inputDefaults": {
    "windowRef": "<当前会话返回的目标窗口引用>",
    "coordinateSpace": "client_relative",
    "expectedSize": {"width": 1505, "height": 1080}
  },
  "steps": [
    {"id": "focus", "operation": "input.click", "args": {"x": 100, "y": 200}},
    {"id": "type", "delayMs": 100, "operation": "input.type_text", "args": {"text": "示例"}},
    {"id": "submit", "operation": "input.key_chord", "args": {"keys": ["ENTER"]}}
  ]
}
```

坐标和尺寸必须来自实际观察；示例数字不能直接套用。`expectedSize` 是整个窗口的物理像素尺寸，即使坐标使用客户区原点。步骤自己的参数覆盖 `inputDefaults`，非 `input.*` 操作不使用这些默认值。默认值可使用已有的 `fromStep` 引用格式。

## 原生窗口检查

- `window_relative`：以实时窗口左上角为原点；`client_relative`：以实时客户区左上角为原点，均为物理像素。
- 携带 `windowRef` 的输入在执行前检查目标仍存在、可见、未最小化、未被禁用且处于前台。
- 鼠标起点与拖动终点必须落在目标窗口上，避免点击遮挡窗口。
- 窗口移动后重新计算原点；提供 `expectedSize` 时，尺寸改变立即报错，要求重新观察布局。
- 不自动夺回焦点。弹窗需要观察并绑定其自身窗口；主窗口引用不能代替弹窗引用。
- 不携带窗口引用的旧式屏幕输入保持兼容，但不享受目标窗口检查。

这些是执行前检查，并非操作系统级原子事务。检查后发生窗口切换仍存在竞争窗口；起点和终点检查也不代表完整拖动路径经过的每个像素均已检查。

## 在程序内部验证前后条件

每步可加入 `before`、`after`，使用只读操作、JSON Pointer 和期望值。默认只查一次；设置 `timeoutMs` 时内部轮询，无需 agent 反复调用。

```json
{
  "id": "setTitle",
  "operation": "ui.set_value",
  "args": {"elementRef": "<标题框引用>", "value": "远航"},
  "after": {
    "operation": "ui.get",
    "args": {"elementRef": "<标题框引用>"},
    "pointer": "/value",
    "equals": "远航",
    "timeoutMs": 1000
  }
}
```

条件失败立即停止，不执行后续步骤，不自动重试已经尝试的动作。`after` 失败不回滚动作。对于文本表单，优先使用已有的 `ui.fill_form`，由原生实现完成填写和验证。

## 回执与 token

新增 `output:summary`，成功仅返回 `status` 和 `completed`。失败返回 `failedStep`、`phase`、`dispatchAttempted` 与错误，不返回此前成功步骤的全部内容。`completed` 只计入动作及其后置条件均成功的步骤。

`dispatchAttempted:true` 只表示调用过动作分发，并不证明系统已接受输入或业务操作已完成；重试前应观察实际状态。保留 `output:all/last` 的兼容行为。`metrics:true` 仍按需返回逐步耗时，不适合作为低 token 默认值。

2026-09-15 验证：MCP 协议、文件传输、原生测试窗口三组回归通过，包括窗口移动跟随、尺寸不符、越界坐标、禁用窗口、前后条件失败与精简回执。未据此宣称 真实应用任务成功率已有提升，后续需要任务级对照测试。
