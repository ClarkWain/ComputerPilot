# 原生 JSONL 开发操作参考

这里是开发者使用的原生 JSONL 协议 `{id, operation, args}`，不是 MCP 工具。日常 Agent 使用 [四工具 MCP](docs/MCP.md)。实际支持项以 `runtime.capabilities` 为准。以下参数使用 JSON 类型；标记可选的字段可省略。

| 操作 | args |
|---|---|
| system.info / process.list / display.list / window.foreground | `{}` |
| app.launch | `executable:string, arguments?:string[], workingDirectory?:string, hidden?:bool` |
| window.list | `titleContains?:string, pid?:integer, includeHidden?:bool` |
| window.get / activate / minimize / maximize / restore / close | `windowRef:string` |
| window.move | `windowRef, x:integer, y:integer, preserveWindowGeometry?:bool` |
| window.resize | `windowRef, width:integer, height:integer, preserveWindowGeometry?:bool` |
| ui.tree / ui.find | `windowRef? / elementRef?, selector?:{name?,nameContains?,role?,automationId?,pid?}, depth?:0..64, limit?:1..10000, offset?:0..100000, nodeBudget?:1..100000` |
| ui.get / ui.focus / ui.invoke / ui.select / ui.toggle / ui.expand / ui.collapse | `elementRef:string` |
| ui.at_point | `x:integer,y:integer`，屏幕物理像素 |
| ui.text / ui.selection | `elementRef, maxLength?:1..10000000` |
| ui.set_value | `elementRef,value:string` |
| ui.set_range_value | `elementRef,value:number` |
| ui.scroll | `elementRef,horizontal?:number,vertical?:number`；0..100，-1 表示该方向不变 |
| capture.desktop | `output:string` |
| capture.display | `displayName:string,output:string`；名称来自 display.list |
| capture.window | `windowRef,output,method?:"screen"或"printWindow"` |
| capture.region | `x,y,width,height,output` |
| capture.element | `elementRef,output` |
| input.move | `x,y` |
| input.click | `x,y,button?:"left"/"middle"/"right",count?:1或2,modifiers?:string[]` |
| input.drag | `x,y,toX,toY,button?,modifiers?` |
| input.scroll | `delta:integer,horizontal?:bool,modifiers?`；Windows WHEEL_DELTA 通常为 120 |
| input.key_chord | `keys:string[]` |
| input.type_text | `text:string` |
| clipboard.read / clipboard.formats | `{}`；read 读取 CF_UNICODETEXT |
| clipboard.write | `text:string`；会替换剪贴板内容 |
| vision.parse | `image:string,model:string,ocrModels?:string` |
| vision.ocr | `image,ocrModels` |
| inspect.hybrid | `windowRef,output,model,ocrModels?,method?` |
| runtime.describe / runtime.capabilities | `{}` |
| action.status | `id:string`；查询本会话 requestId 的回执 |

`CTRL, SHIFT, ALT, WIN, ENTER, TAB, ESC, BACKSPACE, DELETE, LEFT, RIGHT, UP, DOWN, HOME, END, SPACE` 以及大写 A-Z、0-9 可用于组合键。鼠标操作支持 modifiers。各 DesktopPilot 会话通过同一交互会话的命名互斥量串行派发键鼠输入。

输入可附 `coordinateSpace:"image_pixels", imageRef:<本会话 capture 返回引用>`。窗口移动后该截图映射会失效；服务在输入前返回 `stale_image_geometry`。截图解析得到的候选坐标不是自动确认的命中点。

## 回执、超时与取消

写操作可在 args 内携带 `requestId`。同一会话内、相同参数的重复请求返回缓存回执。相同 ID 配不同参数返回冲突。通过父进程保存的回执，工作进程超时或重启后也不会自动重发已知 ID。父服务重启后缓存不保留，不承诺持久 exactly-once。

MCP 服务将原生/UIA/推理工作放入独立子进程，默认单次 provider 调用 60 秒。args 可设置 `providerTimeoutMs:1..600000`。超时或硬取消会终止子进程，使该工作进程所有引用失效；下一次调用按需启动新进程。已经发生的系统输入或外部提交不可回滚，未知结果需先观察。

MCP 取消使用标准 notifications/cancelled，params.requestId 指向 RPC 编号；不再提供取消工具。JSONL 直接执行同步后端，不启用 MCP 工作进程监督。

MCP 批量语义和基础输入分别见 [应用语义](docs/SEMANTIC-PROFILES.md) 与 [批次可靠性](BATCH-RELIABILITY.md)。原生 JSONL 每条消息仍是一个 operation。

## 紧凑查询与连续事件

`ui.tree` / `ui.find` 新参数：

- `format:"compact"`：省略 automationId、controlType、pid、supportedPatterns、clickablePoint；保留引用、名称、role、value、bounds、enabled、offscreen 和树关系。默认 `full` 兼容旧客户端；详情可通过 `ui.get` 补读。
- `stopAfterLimit:true`：收集满 limit 后停止，默认 false。提前停止时 truncated=true、uniqueRef=null，matched 只是已见匹配数，不能据此判断唯一。
- `queryTimeoutMs`：1..600000，默认 60000；在 UIA 调用之间检查，不能中断单个阻塞的 COM 调用。MCP providerTimeoutMs 仍负责外层硬超时。
- `metrics:true`：返回 queryMs 和 payloadBytes（不含 metrics 自身的 UTF-8 JSON 字节数，并非 token）。
- `stopReason`：complete / limit / nodeBudget / timeout / providerError；complete 只表示给定 depth 范围内完成，不代表整个应用树。

先轻量筛选控件，再按需读取匹配结果的模式和点击点。查询保持原遍历顺序，不自动使用缓存的旧页面内容。

生产接入直接启动 `desktop-pilot.exe serve`，通过 UTF-8 标准输入输出保持连接；无需 Node，也不建议套 PTY，以免回显、控制字符和中文编码干扰。已有 mcp.json 是连接示例，不表示已经安装到当前 Agent。

## 可靠填写与原生文件通道

推荐使用 `ui.fill` 替代手工组合点击、全选、输入和回读：

```json
{"operation":"ui.fill","args":{"elementRef":"本会话编辑框引用","text":"第一行\n\n第三行","method":"auto","timeoutMs":10000,"charDelayMs":0}}
```

- `method` 为 auto（默认）、value 或 keyboard。auto 先尝试 ValuePattern 并短暂等待；若回读不匹配，在时间预算内转用键盘替换。已匹配时直接返回 unchanged，不再写入。
- keyboard 使用真实 Enter 输入换行，旧式 Win32 Edit 使用原生全选；其他控件优先 TextPattern.DocumentRange.Select，不支持时使用 Ctrl+A。接口返回成功不代表最终内容正确，仍以完整回读为准。输入期间检查焦点，失去目标焦点时停止并报告错误。不会读取或改动剪贴板。
- 可选 diagnosticPath 指定本地 JSON 文件。仅完整性验证失败时写入 initial、expected、actual、前 16 次回读的时长/差异摘要和最终结果；这些文本不回显到工具返回中。提前抛出的 COM/焦点异常暂不保存此文件。失败返回 diff（UTF-8 字节位置与变化长度，不是字符坐标）、selectionMethod、sentUtf16Units、polls；文件写入失败会报告 diagnosticError，不掩盖输入失败。路径应使用专用诊断文件，已有同名文件会覆盖。默认不保存文本。
- 完整回读优先使用已知 Win32 Edit/RichEdit 的原生文本消息；其他控件使用分段 TextPattern，无 TextPattern 时使用 ValuePattern。无法完整回读时不会宣称成功。
- 比较内容时将 CRLF/CR 统一为 LF，其余字符和空行必须一致。返回 expectedBytes、actualBytes、expectedLines、actualLines、methodUsed、verification、elapsedMs，不回传原文。
- timeoutMs 为 1..60000，charDelayMs 为 0..100，默认 0。无逐字延迟时按 32 个 UTF-16 单元分段发送，代理对不跨段，每段检查焦点，结束仍完整回读。显式正值保留慢速输入。超时后可能已部分修改，必须观察再决定下一步。单个阻塞 COM 调用仍由 MCP providerTimeoutMs 管理；它不是实时系统的严格总耗时上限。
- 原有 ui.set_value 增加 verifyTimeoutMs（默认 1000，可设置 0..60000）。它保留原返回结构；长文本推荐 ui.fill。
- 单动作返回 verification:failed 时 MCP isError=true；批量也会停止，不能把派发成功当成业务成功。

原生可执行文件支持直接读取 UTF-8（无 BOM）请求文件并把响应写入文件，长请求不再穿过终端输入缓冲区：

```powershell
& ./desktop-pilot.exe serve --input requests.jsonl --output responses.jsonl
```

serve 请求文件先放 initialize 和 notifications/initialized，再放 tools/call；jsonl 模式则每行直接写 id/operation/args。文件里的换行文本应是 JSON 转义后的 \n。输入输出不能指向同一文件。进程退出码代表传输执行情况，仍须检查每条响应的 error/isError/verification。

文件模式的同一文件内保持会话引用；进程结束后引用失效。跨多轮交互仍推荐客户端直接维护原生 MCP stdio 连接。此功能没有自动修改 Codex 全局配置，也没有把现有终端会话伪装成直接 MCP 连接。

后台兼容性选项：ui.fill method:legacy 显式使用 LegacyIAccessible.SetValue，仍精确回读，绝不自动回退键盘。ui.get 的 supportedPatterns 现在包含 legacy 和 scrollItem。ui.reveal 优先 ScrollItem.ScrollIntoView，否则 TextPattern.DocumentRange.ScrollIntoView；返回仅表示接口调用成功，需独立确认几何变化。以上均非通用锁屏写入保证。

window.children: windowRef 必填，枚举后代窗口并返回可在本会话使用的 windowRef、className、threadId；可用 className 精确过滤。ui.message_text 为实验接口，指定 elementRef 和同进程 windowRef（调用者必须确认正确宿主），text、placement:append|replace、verifyTimeoutMs。使用 UIA 焦点与文本选区，确认选区后发送 WM_CHAR；换行用 Enter down/up。无需 SetForegroundWindow 或 SendInput。返回派发单元数和完整 ValuePattern 回读验证；目标 HWND 受理消息不代表写入成功。尚未证明浏览器多行替换可靠，不用于默认生产路径。文本最大65536字节，长请求需配置足够 worker 超时。

实验更新：ui.message_text 可指定 deleteTail（0..4096，仅 append），按 UTF-8 码点计算预期尾部删除，再定向发送 Backspace down/up；删除未核验则跳过插入。组合字符的实际删除单位由编辑器决定，不保证等于码点，仍以全文回读为准。verifyTimeoutMs 在操作前校验。末尾空选区仅在端点一致或两者之间文本严格为空时接受；失败返回选区比较值和字节数。该路径依赖应用对定向消息的支持，应通过实际回读验证。
ui.context_menu 使用 IUIAutomationElement3.ShowContextMenu，只报告调用受理；菜单可能来自父元素，必须观察菜单项后再选择。返回成功不能证明菜单属于目标编辑器。

## 会话诊断与编辑消息补齐

system.session 是只读操作，返回当前进程 sessionId、WTS lockState（locked/unlocked/unknown）、connectionState 数值、threadDesktop、inputDesktop、inputDesktopAccessible 和 threadOnInputDesktop（boolean/null）。失败保留 Win32 errors；不把访问被拒绝推断为锁定。WTS 锁定标志按 Windows 10/11 语义解释，本项目不支持 Windows 7 的反向标志。此操作只提供状态，不自动拦截其他操作，也不切换、解锁桌面。threadOnInputDesktop 来自 UOI_IO；不是 SendInput/UIA/浏览器必然成功的承诺。可通过原生 JSONL 查询，MCP 自动执行环境检查。

ui.message_text 的 Backspace 和 Enter 现在按 WM_KEYDOWN → WM_CHAR（退格 8 / 回车 13）→ WM_KEYUP 派发。同步发送不经过目标消息循环的 TranslateMessage，所以显式补齐字符消息；即使前面派发失败也尝试释放键。expectedSuffix 可选：操作前全文回读若不以它结尾，则不发送输入；它不是跨进程原子锁。仍必须看最终 verification，不能按已发送计数判断成功。

原理依据：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-translatemessage
会话依据：https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w



## 窗口绑定与条件批次

`input.*` 可携带 windowRef，以及 coordinateSpace:window_relative/client_relative 和 expectedSize。MCP execute_batch 自动绑定窗口并检查观察状态。参见 [组合命令可靠性](BATCH-RELIABILITY.md)。

诊断补充：system.session 返回实际工作进程的 processId、windowStation、integrityRid、restrictedToken、uiAccess、inJob，以及可查询时的 jobUiRestrictions。字段缺失表示查询未得到结果，不等同于零限制。SendInput 失败现在保留即时 Win32 错误码；访问拒绝不能单独证明 UIPI、锁屏或输入阻塞。

线程诊断补充：threadImpersonating 表示是否存在模拟令牌；desktopGrantedAccess 和 windowStationGrantedAccess 是只读查询得到的句柄访问掩码，不修改权限。即使这些检查正常，也必须以实际输入结果为准，不能把 SendInput 的拒绝直接归因于权限不足。

性能查询：ui.tree/ui.find 的 format:locator 保留 name、automationId、role、bounds 等定位属性，跳过 Pattern 枚举、ClickablePoint 与 ValuePattern 读取；supportedPatterns 空数组、value:null 在此模式下表示未查询。ui.get 可设 details:false 跳过详细查询，默认 true 保持兼容。文本回读仍使用默认详细模式。

`system.session.lastInputTick` 为 GetLastInputInfo 成功时返回的最近输入时间戳（毫秒、32 位计数，包含合成输入）。可用于比较相邻步骤间输入是否变化；缺失代表查询失败，不作为连续的人为干预检测。

语义动作新增 drawing.drawText、drawing.selectBrush、document.saveAs；开发协议通过 semantic.perform，MCP 通过 execute_semantic 调用。参数和限制见 docs/SEMANTIC-PROFILES.md。input.key_chord 新增 F12（保存为）。
# 启动前提与诊断

**同一 Windows 用户会话、同一输入桌面、可用执行令牌是桌面操作前提。** 先 `system.preflight`，`ready:false` 时不要发 UI 输入。`doctor` 提供独立 CLI 诊断；MCP 初始化与能力发现也会返回实际 worker 的诊断。

`system.preflight` 无参数，返回 `ready/status/attentionRequired/code/reasons/session/message/nextAction`。桌面错位、锁屏、输入桌面不可访问、Session 0、受限令牌、作业 UI 限制或关键证据缺失都会提示未就绪。MCP/jsonl 桌面操作会停止在派发前，返回 `desktop_environment_not_ready`；诊断调用仍允许。不要把派发成功当作执行成功。详见 [MCP](docs/MCP.md) 和 [故障处理](skills/desktoppilot/references/troubleshooting.md)。
