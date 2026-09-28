# Suno 音乐创作编排器

这个本机 CLI 接受 `title`、`lyrics`、`style` 三项输入，使用 Suno 网页的 Custom 模式填写、提交并检查生成结果。它复用通用编排的持久化日志；**Create 只自动点击一次**。若点击后无法确认结果，流程停在 `needs_reconciliation`，不会因重试再创建一首。它不增加公开 MCP 工具。

目前已在未登录页面验证登录识别，并以模拟宿主验证填写、提交、恢复和异常路径。实际登录后的 Suno 表单及歌曲生成仍需现场验收；网页控件变化时，编排器会停止并报告，而不是盲点 Create。

## 准备与使用

需要本机 Microsoft Edge 和 `agent-browser` CLI（可运行 `npm install -g agent-browser` 安装）。安装后保持其可执行文件位于用户 npm 全局目录；若位置不同，可设置 `DP_AGENT_BROWSER_EXE`。Edge 不在默认路径时设置 `DP_EDGE_EXE`。浏览器使用 `%LOCALAPPDATA%\DesktopPilot\suno-profile` 独立资料目录；首次需要手动登录 Suno，之后会复用该资料目录。不要把账号密码写进歌曲 JSON。[Suno 官方说明](https://help.suno.com/en/articles/3726721)列出的 Custom 步骤是填写歌词、Styles、Title 并点击 Create。

在仓库根目录运行：

```powershell
npm run build --prefix node
node node/dist/src/suno/cli.js login
# 在打开的 Edge 窗口中手动登录
node node/dist/src/suno/cli.js inspect-site
node node/dist/src/suno/cli.js validate examples/suno/song.example.json
node node/dist/src/suno/cli.js create examples/suno/song.example.json
```

输入文件格式：

```json
{
  "title": "夜晚的车站",
  "lyrics": "[Verse]\n站台的灯还亮着\n...",
  "style": "Mandarin indie pop, warm piano, 90 BPM"
}
```

只接受以上三项。空内容、控制字符和超过本地长度上限的内容会在打开浏览器前拒绝。`create` 在 stderr 先打印运行目录，在 stdout 打印 JSON 报告。运行目录默认位于 `%LOCALAPPDATA%\DesktopPilot\suno-runs`，每次都是新目录；也可用 `--run-dir <new-dir>` 指定。`--profile-dir <dir>` 可选择另一独立浏览器资料目录。账号当前可用的模型和额度由 Suno 页面决定。

## 结果与异常

| 报告 | 含义与下一步 |
|---|---|
| `completed` 且 `result.status=ready` | 新歌曲链接已记录，歌曲页显示可播放状态；链接在 `result.trackUrls`。 |
| `completed` 且 `result.status=submitted_pending` | 新歌曲链接已记录，等待超时但未证明可播放；稍后执行 `check <run-dir>`。 |
| `waiting_decision` | 需要登录。先执行 `login` 并在 Edge 完成登录，再执行 `answer <run-dir> --choice ready` 和 `resume <run-dir>`。`cancel` 会结束这次创作。 |
| `needs_reconciliation`，未决 `inspect`、`prepare` 或 `wait` | 可修正网络、登录或页面问题，再 `resume <run-dir>`；这些步骤最多自动重试三次。 |
| `needs_reconciliation`，未决 `submit` | **先到 Suno 账号中核对是否出现这次新歌**。不能直接重试 Create。若能确定已提交，记录经确认的新歌曲 URL 并按下文核对；若无法确定，保持未决。 |
| `failed` 或页面异常 | 查看 `message`。布局、额度、人机验证、权限或页面跳转可能需要人工处理；不自动绕过。 |

状态和后续检查：

```powershell
node node/dist/src/suno/cli.js status <run-dir>
node node/dist/src/suno/cli.js resume <run-dir>
node node/dist/src/suno/cli.js check <run-dir>
```

`check` 只适用于已有歌曲链接的完成运行，会重新检查歌曲页；不会再提交、也不会改写原运行报告。`ready` 证明歌曲页当前显示可播放，尚未验证下载文件或人工试听质量。Suno 通常会一次生成多个版本，CLI 会返回它在本次提交后识别到的新链接。

如果 Create 已点击但页面没有返回可识别的新链接，准备一个只含经人工确认 URL 的 JSON 文件，例如：

```json
{"status":"submitted","trackUrls":["https://suno.com/song/<实际歌曲ID>"]}
```

再用 `status` 中的 `pending.key` 执行：

```powershell
node node/dist/src/suno/cli.js reconcile <run-dir> <pending.key> --result-json checked.json --reason '已在 Suno 账号中核对新歌链接'
node node/dist/src/suno/cli.js resume <run-dir>
```

人工核对会在日志中标记为人工接受，不冒充机器验证。日志尾部损坏时先按通用编排指南检查并使用 `repair-tail`。日志和定义文件会在本机保存歌词、风格和标题；浏览器资料目录包含登录状态，请自行控制这些目录的访问权限。多个并行任务不能共用同一个浏览器资料目录，编排器会用锁阻止并发操作。
