# macOS 本机验收记录

日期：2026-10-27（Asia/Shanghai）。环境：macOS 26.4 / 25E246，Apple Silicon arm64，core-only 构建。此记录描述本次已运行的测试，不代表其他系统版本、架构或应用的兼容保证。

## 执行环境

用户解锁并授予实际启动宿主辅助功能权限后，重新启动 MCP 连接，检查真正执行请求的 worker：

- `ready:true`，`lockState:unlocked`，同一控制台用户会话。
- Accessibility、事件发送、屏幕录制检查均通过，Secure Input 未启用。
- 所有写入仅针对测试创建的 `DesktopPilot disposable macOS fixture`；结束后终止自己的测试进程。未调整用户已有窗口或修改用户文档/剪贴板。

## 已通过

```sh
cmake --build --preset core-only --parallel 4
ctest --preset core-only -LE interactive
ctest --preset core-only -L interactive --output-on-failure
```

| 验证 | 结果与范围 |
|---|---|
| 非交互回归 | 17 项通过；包含协议、锁屏模拟、权限分类、图像编解码和 worker 恢复 |
| `native-macos-desktop` | 通过，实际执行，未跳过；Cocoa 字段读取/AXValue 回读、Unicode 输入、Command+A、AXPress 按钮反馈、ScreenCaptureKit、几何保持、sheet 阻塞与 sheet 按钮执行 |
| `mcp-macos-desktop` | 通过，实际执行，未跳过；通过持久 `serve` 连接和真实独立 worker，按 PID/标题选择自己创建的窗口，使用公开工具获取状态和执行批次 |
| 公开基础操作 | 控件填写、无 AXPress 字段的指针点击、Command+A、中文/emoji 输入、坐标点击、连续 held move、drag，均以测试应用暴露的结果回读核验 |
| Retina 与裁剪映射 | 本机 2 倍像素比例；整窗 500×392 点 → 1000×784 像素；裁剪 430×100 点 → 860×200 像素；从裁剪图片中心点击后，应用报告 `Pointer drags:0` |
| 截图目视检查 | 查看了原生测试窗口、MCP 整窗与蓝色指针区域的裁剪图片，方向、内容和裁剪区域符合预期 |
| 接口文档 | 使用 `generate-reference.ps1 -Check` 校验通过；公开工具仍为四个，无新增别名 |

公开接口测试检查四个工具的 schema，并实际使用 `list_windows`、`get_window_state`、`execute_batch` 完成任务。因为没有匹配的 macOS 应用 profile，本次不执行 `execute_semantic`，不把其入口存在当成应用语义验收。

测试证据默认保存在忽略的构建目录 `build/core/macos-mcp-artifacts/`，包含 JSON 回执、PNG 与测试进程 stderr；不写入 Git。原生测试可通过 `DP_TEST_ARTIFACTS_DIR` 指定证据目录，否则删除临时截图。

## 本次实测发现并修复

1. CLI 创建的 Cocoa 测试程序没有默认 Edit 菜单，Command+A 事件已到达应用但没有执行全选。补齐标准 responder-chain 的 Select All 菜单；保持测试 action target 的生命周期，避免测试夹具自身影响结果。
2. sheet 内控件的 `AXWindow` 可能返回主窗口，原来的严格等值判断误报 `stale_element_window`。现在只在已知 sheet 目标中沿 AXParent 验证祖先身份，不会仅凭相同应用/PID 放行控件。实际 sheet 阻塞与 Continue 按钮操作通过。
3. 新建测试窗口的初始 Cocoa 放置可能在激活期间完成。几何保持断言以激活后的实际窗口为基准，继续检查读取控件、输入和截图没有改变该窗口几何。

## 尚未验证

- 真实锁屏/解锁发生在原生输入中途的行为；现有锁屏转换、部分执行和恢复测试仍以模拟会话为主。没有自动锁定用户电脑。
- 锁屏期间的任何应用写入；`lockedApplicationActions` 保持空数组。
- 多显示器混合缩放、负坐标、显示器热插拔和跨屏窗口；本次只验收本机目标窗口的 2 倍比例。
- Safari、其他真实业务应用、自绘窗口的完整任务流程；本次写入对象均为自己的 Cocoa 测试夹具。
- Intel、其他 macOS 版本、Windows 本轮回归、可选 Torch/OCR 模型推理，以及发布签名/公证。

## 后续验收

2026-10-28 增加“预览”小花绘制、调用录制导出及完整笔画组检查点续跑的实机验收，本机回归扩大到 21 项非交互与 2 项交互测试。具体流程、像素对照和限制见 [Replay](REPLAY.md) 与 [操作录制](RECORDING.md)；上文 2026-10-27 的夹具验收保留为当时记录。
