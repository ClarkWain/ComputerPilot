# 通用编排 CLI（开发版）

通用编排允许可信本地 JS 用 `for`、`if` 和函数组织多个项目与多个桌面窗口。Node 宿主持久化每条命令的身份、参数、派发意图和结果；重启后从脚本入口重新运行，依次核对历史并返回已提交的结果。只有到达第一条新命令时才访问现场。它不增加公开 MCP 工具；现有四个工具仍由 Node 提供。

现有 [Workflow CLI](WORKFLOW.md) 继续负责经过真实应用验收的 Aseprite 单帧 PNG 批次。通用编排当前支持跨窗口观察、匹配 profile 的语义动作、根据最新控件观察定位的基础输入、有限等待、逐项作用域、提问、暂停/取消和显式核对。它是新的开发接口；目前跨应用场景只有模拟窗口集成测试，尚未完成真实 GUI 业务验收。

## 运行一个不使用桌面的决策示例

在仓库根目录运行：

```powershell
npm run build --prefix node
$definition = 'examples/orchestration/decision/definition.json'
$script = 'examples/orchestration/decision/workflow.mjs'
$runDir = 'workflow-runs/review-example-1' # 必须是尚不存在的目录
node node/dist/src/orchestration/cli.js validate $definition
node node/dist/src/orchestration/cli.js run $definition --trusted-script $script --run-dir $runDir
node node/dist/src/orchestration/cli.js status $runDir
node node/dist/src/orchestration/cli.js answer $runDir --choice include
node node/dist/src/orchestration/cli.js resume $runDir --trusted-script $script
```

`run` 到达问题时返回 `waiting_decision`，退出码为 1；`answer` 只记录选择，再由 `resume` 继续。`validate` 只读取声明和摘要，不导入脚本，也不启动桌面 worker。`run` 和 `resume` 在首次桌面命令前也不会启动原生 worker。

便携包提供 `desktop-pilot-orchestration.cmd` 和同目录的 `ORCHESTRATION.md`；将上述命令的 `node node/dist/src/orchestration/cli.js` 换为该 `.cmd` 即可。脚本与定义文件仍由使用者提供，不包含在便携包中。

定义文件包含 `schemaVersion:1`、`name`、相对定义文件的 `script` 和 JSON `input`。脚本必须显式传给 `--trusted-script`，运行目录冻结入口脚本与输入摘要。每个命令的 ID 在其作用域内唯一，项目键应来自稳定的业务身份；改名、改顺序或修改参数会使恢复拒绝。单次运行最多 10000 条命令，子进程最长运行 30 分钟。

## 作者接口

下面是可直接运行的 [copy-field 模板](../../examples/orchestration/copy-field/definition.json)。先复制该目录，修改定义中的源/目标窗口标题、字段 `name` / `role` 和目标预期旧值 `beforeValue`；标题匹配多扇窗口时补充 `pid`。脚本本身如下：

```js
function readUniqueText(state, field) {
  const inspection = state.inspection;
  if (!inspection || inspection.status !== 'ok' || inspection.truncated === true ||
      inspection.has_more === true || inspection.evidenceComplete === false ||
      (inspection.stopReason !== undefined && inspection.stopReason !== 'complete') ||
      inspection.providerError || !Array.isArray(state.controls)) {
    throw new Error('Source inspection is incomplete; no target input was dispatched');
  }
  const matches = state.controls.filter(control => control.name === field.name &&
    control.role === field.role && control.enabled === true && control.offscreen === false);
  if (matches.length !== 1 || typeof matches[0].value !== 'string') {
    throw new Error('Source requires one enabled visible text field with a string value');
  }
  return matches[0].value;
}

export default async function run(ctx) {
  const input = await ctx.readInput('records');
  for (const record of input.records) {
    await ctx.item(record.id, async item => {
      const source = await item.withDesktop('source', desktop =>
        desktop.observe('read', { target: record.source.target }));
      const text = readUniqueText(source, record.source.field);
      if (typeof record.target.beforeValue !== 'string') {
        throw new Error('Target beforeValue must be a string');
      }
      await item.withDesktop('target', desktop => desktop.step('fill', {
        mode: 'batch',
        target: record.target.target,
        actions: [{ type: 'fill_text', control: record.target.field, text }],
        before: { control: { ...record.target.field, value: record.target.beforeValue } },
        expect: { control: { ...record.target.field, value: text } }
      }));
      await item.checkpoint('done', { sourceId: record.id });
    });
  }
}
```

将前面的 `$definition` 和 `$script` 换为复制目录中的 `definition.json` 与 `workflow.mjs`，并使用新的 `$runDir` 即可运行。源观察必须完整，字段必须按名称和角色匹配唯一且明确启用、可见，值必须是字符串；不满足时本条记录不会写入目标。该示例复制的是已记录的源快照，恢复不会重新读取已提交的观察。源校验失败会终止运行，修正后需新建运行；目标派发前失败按下文 `retry_available` 恢复。

`observe` 返回可持久化的逻辑控件状态，不返回可重用的 `control_id`。`step` 的 `before` 和 `expect` 均必填；运行时在派发前重新找唯一窗口、观察目标、检查 `before`，派发后检查 `expect`。作者应选择能区分目标文档和业务结果的条件，单靠窗口标题并不能证明内容已保存。`mode:'semantic'` 使用当前匹配的 profile 和语义动作；`mode:'batch'` 支持 `click`、`fill_text` 的控件选择器，以及 `type_text`、`press_keys`。基础动作中的控件选择器必须在当前观察里唯一；脚本不能传旧 `control_id`。`waitFor` 使用 Replay 条件格式，只读轮询，`timeoutMs` 上限为 60000。桌面命令必须处于 `withDesktop` 中，同一段持有输入桌面锁，段结束后让出。

命令 ID、`item` 键和 `withDesktop` 键均须为 1..80 个 ASCII 字符，匹配 `[A-Za-z0-9_.-]`；中文业务名称应放在输入数据里，并另设稳定 ID。同一作用域中命令 ID 不能重复，不同 item 可复用 `read`、`fill` 等 ID。逐条 `await` 宿主命令及作用域，不用 `Promise.all` 或 `forEach(async ...)` 并发派发；`withDesktop` 不可嵌套。恢复必须保持相同命令顺序、ID 和参数，循环顺序由已记录输入决定。

可以用 `ask(id,{question,choices})` 等待用户选择，用 `checkpoint(id,value)` 记录业务边界。普通 JS 分支由已记录的输入、观察或回答决定。不要在可信脚本中直接读时钟、随机数或外部文件来决定恢复路径；也不要在宿主命令之外自行执行有副作用的操作。

## 状态与恢复

| 状态 | 处理 |
|---|---|
| `completed` | 全部命令提交；再次 `resume` 不派发动作 |
| `running` | 活动执行，或中断后可继续；查看 `message` 和运行锁 |
| `paused` | 命令边界暂停；`resume` 继续 |
| `cancelled`、`failed` | 原运行终止 |
| `waiting_decision` | 用 `answer --choice` 选择日志中列出的值，再 `resume` |
| `retry_available` | 宿主确认该步尚未调用输入派发；修正现场后显式 `resume` 重试 |
| `needs_reconciliation` | 未决命令或不完整日志；先检查证据，不直接重派写操作 |

活动运行可以请求 `pause <run-dir>` 或 `cancel <run-dir>`；请求在下一条新命令前生效，已派发动作可能先完成。已经提交的命令结果按顺序重放，不重新操作桌面。中断的 `observe`、`readInput` 和 `checkpoint` 最多自动重试三次。

`step` 在输入派发前因 `before` 不满足、目标窗口不唯一、profile 不可用或控件选择不唯一而失败时，返回 `retry_available`，且 `pending.dispatch` 为 `not_dispatched`。修正目标现场后执行 `resume $runDir --trusted-script $script`，重试原命令；此前已提交的步骤不会重派。恢复仍核对原命令身份、顺序和参数，不能改脚本绕过失败检查。只有宿主的类型化派发前错误可写入这条证据，普通错误文本不能解除保护。`run` / `resume` 返回此状态时退出码仍为 1，不会在失败后自行循环重试。

输入派发调用开始后的异常、部分完成、回执丢失或派发后验证失败仍是 `needs_reconciliation`；崩溃后只有未决意图而没有完整的未派发记录时也需核对。历史日志没有此记录的未决写操作保留原有保护。

人工确认当前未决命令后，可把审查所得的 JSON 结果写入文件，再执行：

```powershell
node node/dist/src/orchestration/cli.js reconcile $runDir 'root/item:asset-b/desktop:editor/save' `
  --result-json checked-result.json --reason '已核对目标文档'
node node/dist/src/orchestration/cli.js resume $runDir --trusted-script $script
```

核对记录标记为 `manual_acceptance`，不冒充机器验证。只有当前未决命令可核对；`ask` 必须通过 `answer`。`retry_available` 应优先修正现场后 `resume`；若选择人工核对，同样必须确认原 `expect` 已成立，不能以核对跳过未完成的结果。

内置桌面宿主创建的新运行在 `definition.json` 中记录 `desktopResultContract:"desktop-v1"`。这类运行的 `reconcile` 在追加日志前检查结果格式；缺字段、类型错误或证据标签不足会拒绝，未决命令和日志字节保持不变。格式通过后，恢复把该 JSON 返回给脚本，不重复已提交的输入。它只验证可供脚本使用的格式；实际条件由核对人检查，并在 `--reason` 中说明。旧运行和未声明此契约的自定义宿主保留各自 JSON 契约，`suno` 等扩展命令也不套用桌面格式。

`observe`、`waitFor` 的 `checked-result.json` 使用逻辑状态格式，例如：

```json
{
  "title": "Editor — reviewed document",
  "controls": [{"name": "Message", "role": "Edit", "value": "ready", "enabled": true, "offscreen": false}],
  "inspection": {"status": "ok", "evidenceComplete": true, "truncated": false, "has_more": false, "stopReason": "complete"}
}
```

`title` 必须是字符串，`controls` 必须是数组，每个控件的 `name`、`role` 必须是字符串；`value` 若提供必须是字符串，`enabled`、`offscreen` 若提供必须是布尔值。`inspection` 可省略或为 `null`；提供对象时，`status` 为 `ok`、`incomplete` 或 `error`，完整性字段为布尔值。`stopReason`、`message`、`code` 为字符串，`visited` 为非负整数，`metrics` 为非负数值对象，`providerError` 为字符串或包含字符串 `stage`、`message` 的对象。扩展 JSON 字段允许保留。不要凭空写入完整观察；下游脚本仍可能因证据不完整而拒绝继续。核对 `waitFor` 时，还必须逐项检查记录的 `expect`。

`step` 使用以下结果格式；`status:"verified"` 是返回值契约，日志的核对来源仍为 `manual_acceptance`：

```json
{"status": "verified", "title": "Editor — reviewed document", "verification": "control_checked"}
```

`verification` 按记录的 `expect` 选择，多个条件同时存在时仍应全部核对，标签按下表由上到下选择：

| `expect` 条件 | 允许的标签 | 人工核对证据 |
|---|---|---|
| `file.sha256` | `file_hash_checked` | 目标文件的 SHA-256 与记录摘要相同 |
| `file` 无摘要 | `file_checked`、`file_hash_checked` | 文件存在且满足记录的尺寸、字节数、采样或参考图条件 |
| 无 `file`，有 `control` | `control_checked` | 当前唯一、启用且可见的控件及其预期值 |
| 其余条件 | `condition_checked` | 记录的标题、profile、文件不存在或 capture 条件 |

日志尾部不完整时，`status` 返回 `needs_reconciliation`，普通恢复拒绝。检查后可执行 `repair-tail <run-dir> --reason <text>`：先备份尾部字节，再截除；若留下未决动作，仍需核对。日志中部或顺序损坏不会自动修复。

## 当前边界

- 入口脚本摘要已冻结，导入依赖的内容尚未冻结。脚本属于可信代码，子进程用于停止死循环，不是权限沙箱。
- 真正的跨应用 GUI 操作还需要在目标应用、profile、DPI 和弹窗条件下做现场验收。测试宿主证明调用和恢复顺序，不能替代业务画面验收。
- `waitFor` 中断或超时不会自动重置等待预算；按未决结果核对。没有通用回滚、任意异步外部 effect 恢复或无登录桌面执行承诺。
- 当前没有通用文件产物能力包、多产物事务、流程图编辑器或用户界面。已验收的 Aseprite 批次仍使用专用 Workflow CLI。
