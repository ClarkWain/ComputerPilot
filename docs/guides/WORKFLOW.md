# Workflow CLI 使用指南（首版）

更新：2026-09-25。适用于 Node 分支的源码开发环境。首版已实现并完成本机验收，参见 [验收记录](../validation/WORKFLOW-ACCEPTANCE.md)。

## 适合做什么

将一批已保存的 Aseprite 单帧源文件导出为 PNG，逐项记录结果；遇到中断时检查证据，从可靠的项目边界继续。可选 JavaScript 规则决定每项导出或跳过。产物写入新的运行目录，源文件不覆盖。

当前适配器为 `aseprite-png`，支持 `.ase` 和 `.aseprite`，尺寸上限为 1600 万像素。多帧及其它格式列为不支持，损坏文件列为失败。输入目录递归扫描所有文件，包括文本和隐藏文件，因此应将配置、脚本和说明文件放在输入目录外。

Workflow 通过 Aseprite 后台 CLI 处理磁盘文件；编辑器中尚未保存的修改不会参与导出。它不需要调用四个公开 MCP 工具，也未增加新的 MCP 工具。固定桌面操作序列使用 [Replay](REPLAY.md)，观察差分 Delta 不承担流程恢复。

## 第一次运行

准备 Windows、Node.js 22 或更新版本，以及已安装的 Aseprite。从仓库根目录执行；已有依赖时可略过安装：

```powershell
npm ci --prefix node
npm run build --prefix node
```

1. 将测试用单帧素材放入 `examples/workflow/aseprite-png/input/`，先用少量文件试跑。
2. 修改示例 `workflow.json` 中的 `executable`，指向本机 Aseprite。
3. 阅读示例 `decide-item.mjs`；它会跳过 `_reference` 子目录中的受支持素材。
4. 运行以下命令。每次新批次更换 `$runDir`，该目录必须尚不存在。

```powershell
$config = 'examples/workflow/aseprite-png/workflow.json'
$script = 'examples/workflow/aseprite-png/decide-item.mjs'
$runDir = 'workflow-runs/first-batch'

node node/dist/src/workflow/cli.js validate $config
node node/dist/src/workflow/cli.js plan $config
node node/dist/src/workflow/cli.js run $config --run-dir $runDir --trusted-script $script
node node/dist/src/workflow/cli.js status $runDir
```

结果在 `$runDir/artifacts/`，保留源文件相对目录并将扩展名改为 `.png`。例如 `角色/站立.aseprite` 对应 `artifacts/角色/站立.png`。`same.ase` 与 `same.aseprite` 等输出名称碰撞会在派发前被拒绝。

不需要动态规则时，删除配置中的 `script` 字段，运行与恢复时省略 `--trusted-script`。也可以使用 `npm run workflow --prefix node -- ...`；自动读取 JSON 时建议直接调用上述 Node 入口，避免 npm 自身的提示混入 stdout。

## 配置与路径

```json
{
  "schemaVersion": 1,
  "name": "Aseprite PNG batch",
  "inputDirectory": "./input",
  "outputDirectory": "artifacts",
  "adapter": "aseprite-png",
  "executable": "C:/Program Files/Aseprite/aseprite.exe",
  "maxItems": 500,
  "timeoutMs": 120000,
  "onError": "continue",
  "script": "./decide-item.mjs"
}
```

| 字段 | 规则 |
|---|---|
| `schemaVersion`、`adapter` | 必填，分别固定为 `1`、`aseprite-png` |
| `name`、`inputDirectory`、`executable` | 必填；名称、输入目录、Aseprite 可执行文件路径 |
| `outputDirectory` | 可省略；如指定，只能为 `artifacts` |
| `maxItems` | 默认 500，允许 1–20000；计算所有扫描到的文件 |
| `timeoutMs` | 单项导出超时，默认 120000 毫秒，允许 1000–1800000；不控制脚本决策时限 |
| `onError` | 必填，`stop` 或 `continue`；控制已知失败后的处理，未知结果始终停止待核对 |
| `script` | 可选；声明后，运行必须显式传入相同路径的 `--trusted-script` |

配置内相对路径以配置文件所在目录为基准。命令行的配置路径、`--run-dir` 和 `--trusted-script` 则以当前工作目录为基准。运行目录必须与输入目录分离，不能互相包含；输入及输出路径中的符号链接、junction 会被拒绝。

省略 `--run-dir` 时，CLI 在当前目录的 `workflow-runs/` 下生成唯一目录。启动时 stderr 会提示其路径，最终 JSON 也会返回路径；启动失败时该目录可能尚未创建。

`validate` 和 `plan` 会读取输入并计算摘要，但不导入脚本、不启动 Aseprite，也不验证文档内部内容。`plan` 输出供检查；随后 `run` 会重新创建并冻结自己的清单，并不消费先前打印的 plan。因此检查与运行之间应保持输入不变。

## 查看结果

每个运行目录保存：

| 文件或目录 | 用途 |
|---|---|
| `plan.json` | 冻结输入、路径、源摘要、脚本入口摘要、应用摘要与适配器版本 |
| `execution.jsonl` | 持久化决策、派发意图、回执、提交与人工核对记录 |
| `report.json` | 最近一次写入的汇总缓存 |
| `artifacts/` | 已发布产物 |
| `.staging/` | 待验证或尚未提交的候选文件，异常核对可能需要它 |
| `failed/` | 部分已知失败的隔离候选文件 |

`status` 从计划和日志重建状态，不依赖缓存报告。它不重新计算每个产物的当前摘要；`resume` 会检查已完成项的源和产物证据。因此“状态仍为完成”不等于外部修改后文件仍有效。保留整个运行目录，尤其不要在核对前清空 `.staging/`。

| 单项状态 | 含义与处理 |
|---|---|
| `not_started` | 尚未派发；脚本决策失败时也可能停留在此状态，并带错误消息 |
| `in_progress` | 当前持锁进程正在处理 |
| `completed` | 已验证并提交产物 |
| `skipped` | 动态规则主动跳过，或用户明确核对后跳过 |
| `unsupported` | 格式、帧数或尺寸等不在支持范围 |
| `failed` | 已知失败；恢复不会自动重试该项 |
| `conflict` | 输入、输出或已提交证据冲突 |
| `needs_reconciliation` | 已派发但没有可靠提交结果，必须先核对 |

仅完成项和主动跳过项的批次为 `completed`；含失败、不支持或冲突项的正常收尾批次为 `completed_with_errors`。批次还可能为 `running`、`paused`、`cancelled`、`failed` 或 `needs_reconciliation`。判断时同时查看批次状态、逐项消息与计数。

## 暂停、取消与恢复

在另一个终端设置同一个 `$runDir`，然后按需执行一条控制命令：

```powershell
$runDir = 'workflow-runs/first-batch'
node node/dist/src/workflow/cli.js status $runDir
node node/dist/src/workflow/cli.js pause $runDir
```

`pause`、`cancel` 只接受活动运行，在下一个项目边界生效；当前导出可以先完成。命令成功仅表示请求已记录，应再用 `status` 确认状态。如果请求到达时最后一项已完成，可能直接看到批次完成。

暂停后恢复：

```powershell
$script = 'examples/workflow/aseprite-png/decide-item.mjs'
node node/dist/src/workflow/cli.js resume $runDir --trusted-script $script
```

取消活动运行：

```powershell
node node/dist/src/workflow/cli.js cancel $runDir
```

取消是终止状态，不能继续原批次。需要处理剩余文件时，根据报告选择尚未完成的输入，创建新的输入批次和运行目录。直接对原输入重开批次会再次处理其中已完成的文件。

恢复使用原运行的冻结配置，修改外部 `workflow.json` 不会更新它。已提交项不重新导出；脚本入口、应用、源或产物不匹配时拒绝继续或报告冲突。新增输入不会加入旧清单，修改规则或应用版本后应新建运行。

## 异常后如何处理

- **已知失败**：查看逐项消息和日志。`continue` 可处理后续独立项目；`stop` 会停下。解决问题后可将失败输入单独放入新批次；普通 `resume` 不会重试已失败项。
- **结果未知**：如派发后进程中断或超时，先查看 `status` 和现有候选，再显式核对。Aseprite 已关闭且返回非零退出码通常记为已知失败，并非所有异常退出都属于未知。
- **输入或产物变动**：不要用新文件替换旧证据后直接接受。已提交产物只有恢复到原 SHA-256 后才能按原记录接受；源文件也必须匹配冻结摘要。

从 `status` 找到需要处理的 `itemId`，将下面变量替换为实际值，然后按检查结论选择一条命令：

```powershell
$itemId = '替换为实际 itemId'
node node/dist/src/workflow/cli.js reconcile $runDir $itemId accept --reason '已检查本次导出的候选文件'
# 或：明确不再处理这一项
node node/dist/src/workflow/cli.js reconcile $runDir $itemId skip --reason '已核对，留待单独处理' --acknowledge
```

`accept` 需要持久化导出意图与有效产物证据。尚未提交的项必须保有本次候选；若最终路径已有文件，其摘要还必须与候选相同。仅在最终路径放入一张同尺寸 PNG 不足以接受。`skip` 留下原因与明确确认，不执行回滚、不删除已有产物，也不抹去历史记录。核对后检查状态，再决定是否 `resume`；成功核对后若处于 `paused`，退出码仍为 1。

日志尾部写入中断时，普通恢复会拒绝；显式核对会先备份并截除不完整尾部，再验证可核对的项目。若没有可核对项，或日志中间损坏，保留运行目录供诊断，不保证自动修复。

## 可信 JavaScript 规则

```js
export default async function decideItem(source, probe) {
  if (source.relativePath.split(/[\\/]/).some(part => part.toLowerCase() === '_reference')) {
    return { decision: 'skip', reason: '参考素材不参与交付' };
  }
  return { decision: 'export' };
}
```

规则仅接收受支持文件的源记录和探测结果，返回 `export` 或 `skip`，可附文字原因。宿主持久化决策后再导出；已有决策会复用，已完成项不再调用规则。返回值不能指定其它操作或输出路径。

每项决策在新的 Node 子进程中运行，模块变量不跨项保存，时限为 10 秒。挂起或异常会使批次失败；尚未派发的项目保留错误消息，修复运行条件后可以重新求值。不要将它理解为任意 async 执行现场的恢复。

这是可信本地代码，可直接使用 Node API，具备当前用户权限。入口文件摘要会在加载前检查，导入依赖尚未冻结；规则应保持无副作用，不自行修改文件、调用外部服务或创建后台进程。子进程日志被限量转入 stderr，CLI stdout 保持单行 JSON。`validate`、`plan`、`status`、`pause`、`cancel` 和 `reconcile` 均不导入规则。

## JSON 与退出码

直接 Node 入口每条命令在 stdout 输出一行 JSON；诊断写 stderr。PowerShell 可通过 `$LASTEXITCODE` 读取退出码。

| 退出码 | 含义 |
|---:|---|
| 0 | 命令成功，或批次完成；`status` 成功读取失败批次时也返回 0 |
| 1 | 运行未完成、暂停、取消、失败、含错误或待核对；也可能是运行启动失败 |
| 2 | 命令参数或配置不合法 |
| 3 | 输入、应用或运行环境读取失败等错误；具体看 `error.code` 和消息 |
| 4 | 状态、恢复或核对冲突，包括脚本版本变化 |

不要只用退出码 0 判断批次全部成功：对于 `status` 应读取 JSON 中的 `status`、`counts` 和 `items`。

## 验证范围与已知限制

- 生产验证器检查 PNG 可完整解码、尺寸和透明通道证据，不证明任意源文件与产物视觉等价。本机 24 个有参考图的测试样本另做了逐像素比较，详见验收记录。
- 此 Aseprite 批次 CLI 未提供多帧导出、多规格输出、自定义重命名、跨批次缓存、定时调度或跨机器恢复。另有[通用编排开发版](ORCHESTRATION.md)支持桌面命令，但尚无真实跨应用 GUI 业务验收。
- 运行锁使用 PID 与所有权 token。进程崩溃后若 PID 被其它活动进程复用，恢复会保守阻止，直到该进程退出；尚未绑定 Windows 进程创建时间。
- 应用受执行环境影响。本机 Aseprite 1.2.15 在受限执行环境曾异常退出，正常用户环境通过；不能把异常退出解释为未产生任何文件。
- 首版从源码 CLI 使用；现有发布包未提供专用 Workflow 启动器。实现位置为 `node/src/workflow/`，测试和实际证据见 [验收记录](../validation/WORKFLOW-ACCEPTANCE.md)。
