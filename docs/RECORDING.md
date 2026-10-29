# ComputerPilot 操作录制

录制功能需要显式启用，默认不写操作日志。它记录 ComputerPilot 通过四个公开工具实际执行的调用，不监听用户在其他程序中的手动鼠标或键盘操作。

## 启用

MCP 宿主将启动命令改为：

```sh
./build/core/computer-pilot serve --record out/my-recording
```

`--record` 必须是不存在的新目录。正常操作仍使用原来的四个工具，不新增录制工具或工具参数。关闭 MCP 连接的标准输入后，程序完成日志封口。已有配方也可在实际执行时录制：

```sh
./build/core/computer-pilot replay \
  --file examples/replays/flower-preview/replay.json \
  --mode run --output out/record-source \
  --record out/my-recording
```

回放输出与录制目录必须彼此独立，不能嵌套或复用。运行前仍检查实际 worker 的权限和解锁状态；失败不发送绘图输入。

## 导出可回放配方

```sh
./build/core/computer-pilot recording-export \
  --file out/my-recording/session.jsonl \
  --template examples/replays/flower-preview/replay.json \
  --output out/my-export
./build/core/computer-pilot replay --file out/my-export/replay.json
./build/core/computer-pilot replay --file out/my-export/replay.json \
  --mode run --output out/recorded-replay
```

导出完全离线，不启动应用或发送输入。模板提供目标应用、画布尺寸、背景与定位条件；模板中的笔画和步骤不会复制进导出结果。程序根据日志中的真实调用重新生成笔画和步骤，移除原会话的窗口/控件引用，并为弹出层增加有界等待。初始观察中已开启的二态工具及后续二态控件点击转为目标值 `ensure`，避免重复切换或依赖工具栏原本已开启；绘图前断言录制时的颜色和启用的工具状态。

源流程应从模板描述的空白画布开始；既有文档内容不会随操作录制导入回放。

当前导出支持 macOS 新建 PNG 绘图流程：单次点击、二态控件、按键组合和按住左键的连续笔画。指针可从控件观察的原生点坐标，或同时返回控件的截图（`mode:both`）/Retina 裁剪坐标转换到画布相对位置。界面必须暴露唯一的控件锚点，画布须符合模板的未缩放尺寸；需在录制中显式完成必要的工具、笔宽、颜色设置。其他应用、隐含的初始状态和其他缩放不承诺自动适配。

暂不导出 `execute_semantic`、文字输入、双击、右键/中键、普通移动、独立拖动或带显式 delay 的动作。遇到不支持的动作、多个文档、应用不匹配、模糊定位、越界笔画、未封口/缺失事件、缺少动作后的观察、失败/部分完成/未知输入结果时，整体拒绝导出，不静默跳过。即使故障发生在最后一步，也先检查整份日志，再创建导出目录。失败日志可用于诊断，不当成可直接运行的配方。

## 日志与故障

`session.jsonl` 在每次调用前写 `begin` 并刷新，执行后写同序号 `result`；正常结束写 `end`。崩溃留下未完成日志时，导出会拒绝，不推测动作是否发生。文件写入失败后停止录制与后续输入；执行后日志写入失败会保留真实结果与完成计数，并明确报告 `recording_write_failed`，不自动重试动作。单条记录上限 8 MiB，日志上限 32 MiB。

不记录 `list_windows` 的整个窗口清单，不保存截图像素。日志包含实际观察的窗口标题、控件文字、输入参数与结果；显式录制的文字也会进入日志。macOS 新录制目录和日志仅授予当前用户访问。日志默认放在 Git 忽略的 `out/` 目录，分发检查也拒绝打包 `.jsonl` 操作记录。

运行配方仍遵循 [Replay](REPLAY.md) 的新画布、重新定位、暂停和错误处理规则；可在完整笔画组后显式创建检查点并续跑。本功能不提供自动续跑或锁屏应用写入，续跑片段也不能直接当成从空白画布开始的完整录制配方。

## 本机验收

2026-10-28 在本机 macOS 中文“预览”中录制小花的 27 步、12 条笔画，离线导出为 47 步、12 条笔画的新配方，再在独立新画布上执行全部步骤。录制源和导出配方的两份 1000×800 PNG 均与参考图解码后的 RGB 像素完全一致，并检查最终窗口截图。中途另一次会话状态变化在落笔前触发暂停，未自动重试到同一画布。

20 项非交互测试、2 项实机交互测试、MCP schema/文档一致性检查通过。分发包检查通过，并实际验证了额外 PNG 和原始 `.jsonl` 录制文件会被拒绝。这些结果不代表全局手动输入录制、其他应用或其他系统版本已验收。
