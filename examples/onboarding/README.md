# 从第一个任务迁移到实际应用

macOS 使用 `python3 examples/onboarding/macos-check.py ./build/core/computer-pilot` 做只读连接检查，表单验证使用 `ctest --preset core-only -L interactive`。详见 [macOS](../../docs/MACOS.md)。macOS 的锁屏检查返回后台能力分类；界面批次暂停后，解锁并重新观察，再仅提交未完成动作。下面的 PowerShell/Win32 示例用于 Windows。

在仓库或 Release 根目录执行，入口自动查找本目录的二进制；也可传 -Executable 指定真实程序。只使用原生 ComputerPilot 和 PowerShell。

## 第一步：连接

```powershell
pwsh -NoProfile -File examples/onboarding/start.ps1 -Task check
```

ready 表示实际 worker 的环境预检通过。失败看返回原因，先修正启动方式，不重试点击。ComputerPilot 必须与目标应用处于同一用户会话和输入桌面，且输入权限可用。

## 第二步：完成表单任务

```powershell
pwsh -NoProfile -File examples/onboarding/start.ps1 -Task form
```

打开专用测试窗口，使用四工具接口完成：连接 → 找窗口 → 获取状态 → 填写并 Apply → 获取状态验收。预期 status:passed、fieldsVerified:1、applicationResult 为 Applied: Hello ComputerPilot、staleObservationRejected:true。结束只关闭本次创建的测试窗口。

这个例子同时教会三件事：从观察找控件、把稳定动作合成批次、通过应用变化验收。旧 observation 的重复操作必须被拒绝，而不是再次点击。

## 第三步：迁移到实际应用

阅读 [fill-field.ps1](fill-field.ps1)，参数必须替换为当前应用中实际存在的窗口与输入框：

```powershell
pwsh -NoProfile -File examples/onboarding/fill-field.ps1 -Executable '实际程序路径' -TargetTitle '实际窗口标题' -FieldName '实际输入框名称' -Text '目标内容'
```

它只填写一个唯一匹配的 Edit 控件，不自动提交。UIA 不支持的自绘输入框会明确失败，不保证任意应用兼容。

| 可以复用 | 必须重新确认 |
|---|---|
| client.ps1 的持久连接和工具调用 | 当前程序安装路径 |
| list_windows/get_window_state/execute_batch/验收 顺序，自动焦点恢复 | 目标窗口、输入框名称和唯一性 |
| 使用返回的 window_id/control_id | 不复用上一任务的任何引用或坐标 |
| 参数错误、部分完成、未知结果的处理 | 实际业务完成条件 |
| 单字段先验证，再合并稳定动作 | 填写是否引起弹窗、布局变化或提交 |

## 绘图与批次

`start.ps1 -Task draw` 保留原有 8×8 测试：三色图案、64 格截图验收。它使用 execute_batch 演示基础输入与截图结果对照，普通任务无需先读。它不是 Aseprite 适配器，也不代表艺术质量。

## 文件职责

- start.ps1：程序发现和任务入口。
- client.ps1：持久 MCP 传输；模型不需要管理握手或 RPC ID。
- smoke.ps1：只读常用接口检查。
- form-demo.ps1：端到端表单与旧观察拒绝。
- fill-field.ps1：真实应用单字段迁移模板。
- draw-demo.ps1 / fixture.cpp：专用测试窗口与像素测试。
- generate-reference.ps1：从可执行程序导出唯一 schema，并生成参数参考；-Check 检查是否过时。

## 验收方式

让不继承历史的 Agent 仅获得正式入口和任务。记录到首个成功任务的耗时、阅读量、无效调用、人工提示和最终结果。只有取得可靠计量才报告 token。通过专用窗口不等于实际应用全部兼容；必须继续验收目标应用。
