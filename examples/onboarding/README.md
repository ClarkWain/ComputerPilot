# 从第一个任务迁移到实际应用

源码先构建当前 Node 入口和原生 worker（Node.js 22+、PowerShell 7）：

```powershell
cmake --preset windows-release
cmake --build --preset windows-release
npm ci --prefix node
npm run build --prefix node
```

下面的入口按脚本位置查找源码 `node/dist/src/index.js`，其次查找 Node 包和正式包；不自动选择残留的 `build/core`。也可传 `-Executable` 指定 JS、Node 包 `.cmd` 或旧 C++ `.exe`。从其他工作目录调用时使用脚本的完整路径。

## 第一步：连接

```powershell
pwsh -NoProfile -File examples/onboarding/start.ps1 -Task check
```

ready 表示实际 worker 的环境预检通过。Node 初始化的机器可读值为 `serverInfo._meta['desktopPilot/desktopPreflight']`；客户端也兼容旧 C++ 顶层 `_meta`。失败会返回非零退出码；缺少预检不能视为 ready。失败看返回原因，先修正启动方式，不重试点击。DesktopPilot 必须与目标应用处于同一用户会话和输入桌面，且输入权限可用。

## 第二步：完成表单任务

```powershell
pwsh -NoProfile -File examples/onboarding/start.ps1 -Task form
```

打开专用测试窗口，使用四工具接口完成：连接 → 找窗口 → 获取状态 → 填写并 Apply → 获取状态验收。预期 status:passed、fieldsVerified:1、applicationResult 为 Applied: Hello DesktopPilot、staleObservationRejected:true。结束只关闭本次创建的测试窗口。

`windows-release` 同时构建该测试窗口，不需要旧 C++ 服务。自定义 worker 路径时设 `DP_NATIVE_EXE`；表单/绘图优先在指定入口或 worker 同目录寻找测试窗口，再查默认 `build/release/Release`。缺少测试窗口时先构建，不操作现有用户窗口。

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
