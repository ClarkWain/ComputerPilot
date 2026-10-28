# 粉色小花 Replay

这份文件在 macOS 中文版“预览”中新建白色 PNG 画布，通过真实的标注画笔重画粉色八瓣小花。它使用本次实际绘制成功的 12 条笔画，去掉了错误移动和撤销。`reference.png` 仅供对照，不会被导入当成回放结果。

[观看实际回放 GIF](../../../docs/media/flower-replay.gif) · [原速窗口录屏](../../../docs/media/flower-replay.mp4) · [演示素材说明](../../readme-media/README.md)

## 校验

在仓库根目录运行，不启动应用、不创建文件、不发送输入：

```sh
./build/core/desktop-pilot replay --file examples/replays/flower-preview/replay.json
```

## 实际回放

先解锁电脑，确保实际 worker 的辅助功能、输入与屏幕录制权限可用。`--output` 必须是不存在的新目录：

```sh
./build/core/desktop-pilot replay \
  --file examples/replays/flower-preview/replay.json \
  --mode run \
  --output out/my-flower-replay
```

程序创建唯一命名的新画布并打开“预览”，不选择或覆盖之前的小花。源图、原文档和现有窗口几何不会被当成回放目标；开启标注工具栏引起的应用自身布局变化正常处理。结束后保留新文档打开。

回放包含 27 个步骤（含 5 次弹出层等待）、12 条连续笔画、4424 个画布相对点：花茎、两片叶子、八片粉色花瓣和黄色花心。南侧花瓣从空白处落笔，避免“预览”将落在已有笔迹上的拖动解释为移动旧注解。

输出包括新 PNG、配方副本、`progress.json`、`report.json` 和最终窗口截图 `final-window.png`。报告的 `actions_completed` 只表示动作完成，需要查看图片验收视觉结果。中途失败或锁屏立即停止，不自动重试、不自动恢复；已产生的笔画不回滚。保留新画布并检查报告，不整批重复执行到同一文档。

## 分段执行

可在完整笔画组后暂停，并在同一文档上继续：

```sh
./build/core/desktop-pilot replay \
  --file examples/replays/flower-preview/replay.json \
  --mode run --output out/split-flower --stop-after 14
./build/core/desktop-pilot replay-resume --from out/split-flower --stop-after 20
./build/core/desktop-pilot replay-resume --from out/split-flower
```

这三个阶段分别累计完成 3、11、12 条笔画。保持文档打开及工具、笔宽、选区现场；文件和可观察状态不匹配时拒绝续跑，完成的运行也不能再次续跑。未知/部分执行的失败不能强行跳过。检查点和报告说明见 [Replay](../../../docs/REPLAY.md#检查点暂停与续跑)。

## 当前适配条件

- macOS 原生后端，中文“预览”（bundle ID `com.apple.Preview`，可执行文件 `Preview`）。
- 白色画布 1000×800；当前可见 AXImage 也须为 1000×800 点，拒绝在缩放不匹配时继续画。
- 配方通过控件名称/角色和调色板网格尺寸重新定位；颜色选择后先回读透明色名称或 RGBA，未达到预期就停止。
- 没有录入旧 window_id、control_id、imageRef 或 Agent 状态编号。窗口移动时，笔画以重新观察到的画布原点定位。
- 配方保存结构化动作流程；演示 GIF 由实际运行时的窗口录像转换。DesktopPilot 调用录制并非全局人机操作录制器，界面版本/语言变化可能导致定位失败。

格式与限制见 [Replay 文档](../../../docs/REPLAY.md)。

## 本机验收

2026-10-28 已在解锁并授权的 macOS 中文“预览”中完成一次完整回放：27/27 步、12/12 笔画，用时约 79 秒。检查了保存的 PNG 与最终窗口截图；新 PNG 为 1000×800，解码后的 RGB 像素与 `reference.png` 完全相同。原图保持不变。

19 项非交互测试、2 项实机交互测试和 MCP schema/文档一致性检查均通过，实机测试包含相同位置和大小的窗口标题定位。

这是本机当前界面的验收结果，不代表其他系统版本、语言或缩放也已验证。
