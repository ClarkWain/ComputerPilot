# 冷启动改进与验证记录

## 暴露的问题

2026-09-16 的新 subagent 测试不继承先前桌面任务历史。它从仓库文档发现文件通讯通道，在 Aseprite 绘制 32×32 像素图，从首个原生查询到完成约 8 分 22 秒，另有约一分钟读文档。主 agent 提醒过一次交互桌面权限，因此不能称为完全无人协助。

主要障碍：沙箱输入有成功回执但无界面效果；新建尺寸输入未完整生效；颜色文本字段不更新。后两项依靠界面观察与替代控件纠正。这次不把问题归为“换坐标重试”或“统一加长等待”。

## 本次实现

- `doctor`、`system.preflight` 和自动启动诊断检查执行桌面；MCP 初始化 instructions 与 _meta 明确提示，runtime.capabilities 也包含诊断。
- serve/jsonl 桌面操作在不适合的执行环境中于派发前失败，保留只读诊断。受限令牌即使处于 Default 也按不支持处理。不会自动提权、解除宿主沙箱或切换输入桌面。
- AGENTS.md / README / MCP / skill 重复关键桌面前提；细节按需链接到通讯、故障表和 Aseprite 工作流。
- 附持久原生 MCP 客户端、只读 smoke、独立 8×8 三色 UI 示例和 skill 安装脚本。

## 实测结果

| 验证 | 结果 |
|---|---|
| core-only 构建 | 通过 |
| 非交互 CTest（当时 13 项） | 全部通过，包含 preflight 分类和 MCP 初始化/拦截检查 |
| 沙箱 doctor | 明确报告 CodexSandboxDesktop / Default 不一致、非输入桌面、受限令牌 |
| 沙箱 MCP smoke | worker 即使在 Default，仍因 restricted_execution_token 返回未就绪 |
| 交互桌面专用绘图示例 | passed，40 个步骤，64 格检查，0 格差异 |
| 示例执行时间 | 一次实测端到端 2577ms；批次 1540.3509ms，不是跨环境性能承诺 |

示例读回真实窗口截图中心像素，避免用输入回执自证成功。它的 64 格无差异只证明专用测试图按计划画出，不证明 Aseprite 全版本兼容，更不证明艺术质量。尚未用新文档再做一次完全独立的 Aseprite 冷启动复测。

生产任务仍需目标窗口选择、字段回读、状态转换后的观察和最终结果验收。直接嵌入 C++ Service 的调用方应在工作流入口自行运行 preflight；服务器通道的拦截并不自动覆盖所有外部 C++ 消费者。

## 四工具与 profile 选择改版（2026-09-16）

- MCP 只注册 list_windows、get_window_state、execute_semantic、execute_batch，旧名请求返回 Unknown tool。
- 状态编号与焦点恢复由程序处理；语义 profile 按当前应用和 UI 条件发现，执行前重新检查。
- 语义 actions 支持图形、折线、文字、刷子与保存混合批次，先校验参数；保留图形批次的状态复用。
- core-only 编译通过，16 项非交互 CTest 全部通过。新增 profile-selection 含 16 项断言；Agent API 含 25 项断言。覆盖唯一/多项/无匹配、错误应用、类名、DPI、宽度、缩放、控件歧义、不完整查询、显式 profile、执行前 UI 变化、未知动作与路径参数拒绝。
- 真实表单焦点恢复测试在初始化阶段因 session_locked / input_desktop_unavailable 停止，未创建测试窗口或发送输入。本次未完成解锁桌面的表单与绘图实测；上方历史成功结果不能作为本次改版实测结果。
- README、MCP、Skill、语义说明、参数生成器和入门脚本使用相同四工具词汇。更新二进制后必须重连 MCP。
