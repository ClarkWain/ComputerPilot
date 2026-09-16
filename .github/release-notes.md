DesktopPilot v0.4.0：面向 Agent 的原生 Windows 桌面自动化与 MCP 服务。

## 主要变化

- MCP 精简为四个工具：`list_windows`、`get_window_state`、`execute_semantic`、`execute_batch`。
- 根据当前软件、DPI、布局和控件匹配应用 profile；附带经典中文版 Paint 绘图、文字、刷子和保存语义。
- 同批次复用样式与控件定位，支持紧凑连续鼠标路径。
- 检查交互桌面，恢复目标窗口焦点，报告阻挡输入的模态窗口。
- 截图最长边限制为 1600，支持局部截图、WebP、PNG 回退与坐标转换。
- 更新 Skill、MCP 文档、入门示例和工具参考；17 项本地非交互回归通过。

## 升级

这是不兼容的 MCP 工具命名调整。旧客户端须按 `docs/MCP.md` 迁移调用，更新 Skill，并重启服务、刷新工具列表；不保留旧别名。

解压 ZIP 后，将 MCP 客户端配置为运行 `bin/desktop-pilot.exe serve`，并让它与目标应用处于同一 Windows 用户会话和输入桌面。需要 Windows x64 和 Microsoft Visual C++ 2015–2022 x64 Runtime。运行不需要 Node 或 Python。

## 验证边界

执行成功不等于绘图质量合格：已删除逐图形像素抽样方案，批次后应查看画布截图。小尺寸原生 Paint 多边形仍有已知问题；扫描线绘图实验尚未集成为自动语义后端。任意后台应用输入、任意弹窗处理及锁屏绘图不在本版保证范围内。

本 Core 包包含程序、profile、Skill、示例和许可证，不包含模型权重或大型图标描述模型。截图使用静态链接的 WebP 编码器；宿主不支持 WebP 时设置 `DP_IMAGE_FORMAT=png`。

使用 `SHA256SUMS.txt` 核验 ZIP；变更、构建与许可详见 `CHANGELOG.md`、`docs/BUILDING.md` 和 `THIRD_PARTY_NOTICES.md`。
