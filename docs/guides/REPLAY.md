# DesktopPilot Replay（第一阶段）

Replay 目前是 Node 层的独立 CLI，公开 MCP 仍只有四个工具。第一阶段支持固定的语义动作序列；运行时重新发现窗口和 profile，不保存会话 `window_id`。当前执行层仅支持 Windows。远程桌面会话若 `desktopPreflight.ready` 为 false，`play` 在输入前拒绝运行。

## 文件与命令

回放原稿是一个目录，包含 `manifest.json`、`steps.json` 和可选的 `assets/`。可参考 `examples/replay/save-paint/`。`manifest.json` 声明 `schemaVersion:1`、名称以及目标窗口的 `titleContains` 和可选 `pid`；目标必须唯一。资源在 `manifest.assets` 中以相对路径和 SHA-256 声明。`steps.json` 是有序数组，每步有唯一 `id`、已安装的 `profile`、一个语义 `action` **或** 1–256 个语义 `actions`、可选 `before` 和必需的 `expect`。多动作步骤一次派发，只有全部动作确认完成才提交；部分执行或结果不明时停止。条件可检查窗口标题、profile、唯一可见控件及其值、文件存在或不存在；`expect.file.path` 相对于新运行目录，可附加 `minBytes`、`sha256`、图像 `width`/`height`、`samples`（像素坐标、RGB、容差），或 `reference`（已声明的图像资源、每通道容差、允许变化的像素百分比）。`settleTimeoutMs` 控制执行后等待条件成立的时间，默认 10 秒，最大 30 秒；只重复观察，不重复派发动作。`{{runDir}}` 和 `{{assetDir}}` 可用于动作参数中的输出路径及资源目录。`expect.profileAvailable` 只确认执行后的兼容性，不能证明绘图内容正确。

```powershell
npm run build --prefix node
npm run replay --prefix node -- validate ../examples/replay/save-paint
npm run replay --prefix node -- export ../examples/replay/save-paint G:\runs\save-paint.dpreplay
npm run replay --prefix node -- play ../examples/replay/save-paint G:\runs\paint-001
npm run replay --prefix node -- inspect ../examples/replay/save-paint G:\runs\paint-001
# 仅在 inspect 返回 resumable 且下一步有强前置条件时：
npm run replay --prefix node -- resume ../examples/replay/save-paint G:\runs\paint-001
```

### 从 Agent 操作生成草稿

在启动 Node MCP 前设置 `DP_REPLAY_RECORD_DIR` 为一个仅自己可访问的目录。服务会在标准错误输出新建的 `agent-*.jsonl` 路径；启用后，`execute_semantic` 和 `execute_batch` 会先写 intent，再派发动作，最后写回执。记录可能包含输入文字和本机路径，分享前必须审查。正常 MCP 服务的四个公开工具不变。

```powershell
$env:DP_REPLAY_RECORD_DIR = 'G:\runs\pilot-recordings'
# 启动 Node MCP，并让 Agent 按正常流程操作
npm run replay --prefix node -- draft 'G:\runs\pilot-recordings\agent-....jsonl' 'G:\runs\my-draft'
npm run replay --prefix node -- validate 'G:\runs\my-draft'
```

`draft` 只处理已确认成功、每次一个动作的语义调用；遇到基础键鼠批次、多动作语义调用、结果不明、目标标题变化或缺少 profile 时拒绝生成，避免遗漏有副作用的操作。生成目录含 `manifest.json`、`steps.json` 和 `DRAFT-NOTES.md`。草稿会把 `document.saveAs` 的输出改为运行目录变量，但不会凭操作回执推断作品内容正确。请补充文档基线与内容级验收，再导出分享。

`validate` 只解析并检查格式与资源摘要，不操作桌面。`export` 生成单个 `.dpreplay`，拒绝固定进程 ID、绝对动作路径以及指向原稿目录外的资源链接；`validate` 和 `play` 都可直接读取该文件。导入检查归档路径、大小、资源声明与摘要。`play` 要求一个不存在的新运行目录，先检查原生 worker 的桌面环境，再取得独占输入锁。每步重新枚举窗口、观察 profile 与 `before`、记录 intent、执行本步语义动作、记录回执、等待 `expect` 成立。运行目录中的 `execution.jsonl` 按事件持久化；结果不明、部分执行或验证失败时停止，不自动重试。输出目录保留供人工核验。若某步只检查 profile 或文件元数据，运行结束标记为 `verification:partial`，不能据此认定作品内容已验收。

`inspect` 只读取运行日志，并核对 recipe 内容摘要及已提交的步骤顺序。`resume` 不在结果不明的动作后自动续播；只允许从完整提交的步骤之后继续，且下一步 `before` 必须含控件精确值、文件 SHA-256 或阶段截图参考图，运行时会再次核对。仅有标题、profile 或文件不存在不足以证明文档仍是同一状态。继续播放是显式操作，不会重放已提交步骤；用户仍需确认其它应用状态没有改变。

播放和 MCP 输入共用按当前 Windows 用户/会话命名的锁；MCP 的状态读取也会激活窗口，因此同样取得锁。当前锁只协调使用新版 Node 服务的进程，不能阻止用户、旧版 C++ 服务或其他自动化工具输入。运行前应保持桌面可交互。

## 当前限制与下一阶段

### 画面稳定与阶段截图

步骤可设置 `settle:{"mode":"image","quietMs":150,"pollMs":75,"timeoutMs":3000}`。Replay 在派发成功后重复观察窗口图像，连续保持不变才检查后置条件。它依据画面变化等待，不给所有按键添加固定间隔。动画或持续变化的窗口可能超时，应按步骤启用。

`before.capture` 和 `expect.capture` 可通过唯一可见控件的 `nameContains`、`role` 与 `inset` 定位截图；偏移单位为 `dip96` 或 `pixels`。还需指定 `width`、`height`，以及 `savePath` 或包内 `reference`。参考图使用与最终文件相同的通道容差和变化像素比例规则，并须列入 `manifest.assets`。区域越界、锚点不唯一或图像不符都会停止回放，不会重发已执行动作。`savePath` 保存截图供检查。

- 本阶段支持显式记录语义操作并生成待审核草稿，以及经过强前置条件重验的显式续播；尚不支持任意 Agent 操作的一键导出、基础键鼠批次转换、结果不明时自动恢复、JS 编排或跨平台执行层。
- `profileAvailable` 是弱后置条件。绘图类步骤必须补充文档或图像验收，才能将整个回放判定为成功；目前 CLI 仅把它记为 `profile_compatibility_only`。
- JS 将作为生成步骤的作者代码；需要运行时 JS 的流程单独设计受信任模式。
