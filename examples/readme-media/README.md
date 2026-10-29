# README 演示素材

`docs/media/semantic-{circle,text,save}.png` 及对应的 `-en.png` 英文版本是流程示意图，展示一个已实现的应用语义动作如何封装多个界面操作。动作来自经典中文版 Paint profile；图中的步骤是说明性拆解，实际调用数取决于工具、颜色、布局和缓存状态，不能当作固定提速倍数。

使用 Python 3 与 Pillow 重新生成：

```sh
python3 examples/readme-media/generate-diagrams.py
```

在仓库根目录执行。默认使用 macOS 的冬青黑体与 Menlo 字体；其他系统可用 `--font` 与 `--mono-font` 指定包含中文字符的字体和等宽字体。

## 小花真实 Replay 录屏

2026-10-28，在已解锁且已授权的 macOS 中文“预览”中，实际执行仓库的 `examples/replays/flower-preview/replay.json`：

- 使用独立的新输出目录、新 PNG 和新窗口，保留已有文档。
- 原生 Replay 完成 **27/27 步、12/12 笔画**，运行报告耗时 **92.625 秒**。
- 检查保存的 1000×800 PNG，解码后 RGB 与 `reference.png` 完全相同。视频压缩和 GIF 调色板不参与该像素一致性比较。
- 系统 `screencapture -v -V 120 -l 新窗口编号` 只录制本次新建的 Preview 窗口，不采集音频。
- 原始 MOV 为 2228×2098，裁掉窗口阴影后为 2000×1870；视频保留窗口标题、工具栏和完整画布。

`flower-replay.mp4` 保留前 94 秒的原速过程，以 15 fps 编码。`flower-replay.gif` 使用同一段录屏，4 倍速、12 fps、800 像素宽，末帧额外停留 2 秒后循环。未拼接参考图、未合成笔画、未删除中间操作。窗口捕获不包含独立弹出窗口，工具与颜色变化可在工具栏和真实笔迹中看到。

原始 MOV 和原始调用日志留在忽略的本地输出目录，不纳入仓库；公开素材移除源录像的元数据。下面的 FFmpeg 命令用于本次录屏，裁切参数需随新录像实测调整：

```sh
ffmpeg -i flower-replay.mov -t 94 \
  -vf 'crop=2000:1870:114:78,scale=1000:-2:flags=lanczos,fps=15' \
  -an -map_metadata -1 -c:v libx264 -crf 25 -preset medium \
  -pix_fmt yuv420p -movflags +faststart flower-replay.mp4

ffmpeg -i flower-replay.mov \
  -filter_complex '[0:v]trim=duration=94,setpts=(PTS-STARTPTS)/4,crop=2000:1870:114:78,scale=800:-1:flags=lanczos,fps=12,tpad=stop_mode=clone:stop_duration=2,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle' \
  -an -map_metadata -1 -loop 0 flower-replay.gif
```

这段视频展示通用控件与基础输入驱动的 macOS Replay。语义示意图展示 Windows Paint 适配能力，两者是不同的演示场景。

The video retains its pre-rename DesktopPilot window title; the recording itself has not been altered for branding.
