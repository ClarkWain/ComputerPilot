DesktopPilot v0.5.0：面向 Agent 的原生 Windows 桌面自动化与 MCP 服务。

## 主要变化

- MCP 精简为四个工具：`list_windows`、`get_window_state`、`execute_semantic`、`execute_batch`。
- 根据当前软件、DPI、布局和控件匹配应用 profile；附带经典与受限现代中文版 Paint 语义，以及 Aseprite v1.2.15 的热键/点击适配。
- 现代 Paint 仅适配记录的 11.2605.81.0、120 DPI、100% 缩放范围。Aseprite 的 OCR 菜单动作只在 OCR 可用的构建中显示；Core 包不含 OCR/模型，也不提供 Aseprite 保存或像素绘图动作。
- 同批次复用样式与控件定位，支持紧凑连续鼠标路径。
- 检查交互桌面，恢复目标窗口焦点，报告阻挡输入的模态窗口。
- 截图最长边限制为 1600，支持局部截图、WebP、PNG 回退与坐标转换。
- 更新可靠性处理、Skill、profile 文档和回归覆盖。发布构建由 Windows CI 重新执行非交互测试与包检查。

## 升级

MCP 工具名称保持不变。升级后重启服务并刷新工具列表，以载入新的 profile 能力。

解压 ZIP 后，将 MCP 客户端配置为运行 `bin/desktop-pilot.exe serve`，并让它与目标应用处于同一 Windows 用户会话和输入桌面。需要 Windows x64 和 Microsoft Visual C++ 2015–2022 x64 Runtime。运行不需要 Node 或 Python。

## 验证边界

执行成功不等于绘图质量合格：已删除逐图形像素抽样方案，批次后应查看画布截图。小尺寸原生 Paint 多边形仍有已知问题；扫描线绘图实验尚未集成为自动语义后端。任意后台应用输入、任意弹窗处理及锁屏绘图不在本版保证范围内。

本 Core 包包含程序、profile、Skill、示例和许可证，不包含模型权重或大型图标描述模型。截图默认 PNG（兼容所有宿主）；确认宿主支持 WebP 时设置 `DP_IMAGE_FORMAT=webp`（编码器已静态链接）以减少字节。

使用 `SHA256SUMS.txt` 核验 ZIP；变更、构建与许可详见 `CHANGELOG.md`、`docs/BUILDING.md` 和 `THIRD_PARTY_NOTICES.md`。
