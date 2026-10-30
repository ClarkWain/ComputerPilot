# Node 业务层 / C++ 平台层重构验收记录

日期：2026-09-23；分支：`refactor/node-orchestration`。本记录描述当前工作区，未发布正式版本。

## 已形成的边界

| 层 | 当前实现 |
|---|---|
| 公开 MCP | Node stdio 服务仅注册 `list_windows`、`get_window_state`、`execute_semantic`、`execute_batch`；schema 唯一来源为 `node/src/mcp/tools.json`。返回 `structuredContent`；默认 `content` 为空，显式请求内联截图才有 image 块。 |
| Node 业务 | 管理窗口/控件/截图引用、worker 代数、超时/取消、观察与输入坐标映射、DPI/profile 匹配、Paint/Aseprite 语义动作、批次、OCR 与 OmniParser ONNX 推理。 |
| C++ 默认目标 | `desktop-pilot-native.exe` 只链接 `dp_desktop`、`dp_platform` 和平台/图像编码库；以私有 JSONL 提供 Win32/UIA、输入、截图及会话检查。模型预处理、NMS、OCR、MCP 和语义代码不进入默认目标。 |
| 旧 C++ 实现 | 仅在 `DP_BUILD_LEGACY=ON` 时构建，供迁移对照。文件尚未删除；它不是当前 Node 服务的后端。 |

Node 和原生进程在同一 Windows 用户会话中运行。worker 启动和输入前检查交互桌面；输入前还比较目标进程与 worker 的完整性级别，权限更高或身份不可核实时拒绝派发。Node 超时/取消会使 worker 代数和引用失效，不自动重放可能已执行的输入。

## 验证结果

| 项目 | 结果与边界 |
|---|---|
| Node 单元和集成 | `npm test --prefix node`：37/37 通过，无跳过；包含 MCP 2025-06-18、四工具、Unicode JSONL、worker 超时与引用失效、DPI/坐标、profile、Aseprite OCR、固定图 OCR/检测。 |
| 默认 C++ 构建 | 独立 `build/native-boundary-verify` Release 构建成功；非交互 CTest 2/2 通过。 |
| 旧实现回归 | 独立 `build/native-split-verify` 完整构建成功；非交互 CTest 20/20 通过。原 `build/core/Release/desktop-pilot.exe` 被现有进程占用，原目录构建无法覆盖，原目录的旧可执行文件测试不代表最新源码；以独立目录结果为准。 |
| 真实 Paint | Node MCP 在一次性空白经典 Paint 窗口匹配 profile，并执行 `drawing.drawLine`；前后截图确认画布新增预期黑色斜线。窗口未保存并已关闭。默认截图返回路径且 MCP `content=[]`；显式内联返回一个 image 块，解码哈希与截图文件一致。 |
| 真实 Aseprite | 当前安装为中文界面；英文 profile 的 `File` OCR 证据未通过，返回 `visual_menu_not_confirmed`，未点击。临时窗口已关闭。英文界面实际菜单点击和保存未验证。 |
| 视觉模型 | 固定 `ui.png` 上 OCR 为 11 行；OmniParser 四个框与旧 C++ 类别/顺序一致，分数差 <0.0001、坐标差 <0.001 像素。更多图片、旋转文字和性能尚未形成等价性结论。 |
| 便携包 | `out/dist/DesktopPilot-Node-rc2` 含包内 Node 22.15.0、原生 worker、生产依赖、OCR 和 OmniParser ONNX。1614 个受清单管理的文件通过 SHA-256 校验；包总计 680,449,175 字节。无全局 Node/Python 路径的冒烟测试加载两类模型、协商四工具并只读列窗；随附客户端也完成启动和 stdin 关闭退出测试。前一版同布局包还复制到仓库外临时目录通过了同样的便携冒烟测试。 |

## 尚未达到正式切换的条件

- 便携包已做无全局 Node/Python 路径的本机及仓库外临时目录测试，尚未在另一台无开发工具的 Windows 机器测试。OmniParser 权重的精确再分发许可仍待确认；当前包只适合内部验证。
- 目标窗口高于 worker 完整性级别的真实 UIPI 场景尚无受控窗口可测；当前只有协议和拒绝派发测试。
- Aseprite `saveAsDefault` 仍依赖既有固定坐标，只在 DPI 96 且约 2578×1398 物理窗口时公布，并在执行前复核；英文界面实际保存落盘仍待验收。跨用户分享该 profile 不应仅依赖窗口大小。
- 旧 C++ 业务源码和旧 CLI 仍作为显式兼容构建保留。删除它们及正式切换公开发行入口，应在上述真实场景验收后进行。
