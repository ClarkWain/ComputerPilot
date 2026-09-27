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

```js
export default async function run(ctx) {
  const input = await ctx.readInput('records');
  for (const record of input.records) {
    await ctx.item(record.id, async item => {
      const source = await item.withDesktop('source', desktop =>
        desktop.observe('read', { target: { titleContains: 'Source App' } }));
      const text = source.controls.find(control => control.name === 'Message').value;
      await item.withDesktop('target', desktop => desktop.step('fill', {
        mode: 'batch',
        target: { titleContains: 'Target App' },
        actions: [{ type: 'fill_text', control: { name: 'Message', role: 'Edit' }, text }],
        before: { control: { name: 'Message', value: '' } },
        expect: { control: { name: 'Message', value: text } }
      }));
      await item.checkpoint('done', { sourceId: record.id });
    });
  }
}
```

`observe` 返回可持久化的逻辑控件状态，不返回可重用的 `control_id`。`step` 的 `before` 和 `expect` 均必填；运行时在派发前重新找唯一窗口、观察目标、检查 `before`，派发后检查 `expect`。作者应选择能区分目标文档和业务结果的条件，单靠窗口标题并不能证明内容已保存。`mode:'semantic'` 使用当前匹配的 profile 和语义动作；`mode:'batch'` 支持 `click`、`fill_text` 的控件选择器，以及 `type_text`、`press_keys`。基础动作中的控件选择器必须在当前观察里唯一；脚本不能传旧 `control_id`。`waitFor` 使用 Replay 条件格式，只读轮询，`timeoutMs` 上限为 60000。桌面命令必须处于 `withDesktop` 中，同一段持有输入桌面锁，段结束后让出。

可以用 `ask(id,{question,choices})` 等待用户选择，用 `checkpoint(id,value)` 记录业务边界。普通 JS 分支由已记录的输入、观察或回答决定。不要在可信脚本中直接读时钟、随机数或外部文件来决定恢复路径；也不要在宿主命令之外自行执行有副作用的操作。

## 状态与恢复

| 状态 | 处理 |
|---|---|
| `completed` | 全部命令提交；再次 `resume` 不派发动作 |
| `running` | 活动执行，或中断后可继续；查看 `message` 和运行锁 |
| `paused` | 命令边界暂停；`resume` 继续 |
| `cancelled`、`failed` | 原运行终止 |
| `waiting_decision` | 用 `answer --choice` 选择日志中列出的值，再 `resume` |
| `needs_reconciliation` | 未决命令或不完整日志；先检查证据，不直接重派写操作 |

活动运行可以请求 `pause <run-dir>` 或 `cancel <run-dir>`；请求在下一条新命令前生效，已派发动作可能先完成。已经提交的命令结果按顺序重放，不重新操作桌面。中断的 `observe`、`readInput` 和 `checkpoint` 最多自动重试三次；未决写操作需要人工核对。

人工确认当前未决命令后，可把审查所得的 JSON 结果写入文件，再执行：

```powershell
node node/dist/src/orchestration/cli.js reconcile $runDir 'root/item:asset-b/desktop:editor/save' `
  --result-json checked-result.json --reason '已核对目标文档'
node node/dist/src/orchestration/cli.js resume $runDir --trusted-script $script
```

核对记录标记为 `manual_acceptance`，不冒充机器验证。只有当前未决命令可核对；`ask` 必须通过 `answer`。日志尾部不完整时，`status` 返回 `needs_reconciliation`，普通恢复拒绝。检查后可执行 `repair-tail <run-dir> --reason <text>`：先备份尾部字节，再截除；若留下未决动作，仍需核对。日志中部或顺序损坏不会自动修复。

## 当前边界

- 入口脚本摘要已冻结，导入依赖的内容尚未冻结。脚本属于可信代码，子进程用于停止死循环，不是权限沙箱。
- 真正的跨应用 GUI 操作还需要在目标应用、profile、DPI 和弹窗条件下做现场验收。测试宿主证明调用和恢复顺序，不能替代业务画面验收。
- `waitFor` 中断或超时不会自动重置等待预算；按未决结果核对。没有通用回滚、任意异步外部 effect 恢复或无登录桌面执行承诺。
- 当前没有通用文件产物能力包、多产物事务、流程图编辑器或用户界面。已验收的 Aseprite 批次仍使用专用 Workflow CLI。
