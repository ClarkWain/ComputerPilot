---
name: desktoppilot
description: 使用 DesktopPilot 操纵 Windows 桌面软件，读取控件和截图，执行应用语义、填写表单、键鼠操作并验证结果。实际桌面操作时使用；解释软件用法或编辑代码时无需使用。
---

# 使用 DesktopPilot 操纵电脑

这个 Skill 教 Agent 通过 DesktopPilot 操纵 Windows 电脑完成任务，例如在画图软件中绘画，在浏览器中搜索、填写表单，或操作 Photoshop、Blender 等软件的界面。Agent 负责理解目标、选择操作和验收结果；DesktopPilot 作为中间层执行实际操作。

**用途与限制：** 有匹配 profile 的软件可以直接执行语义动作；其他软件使用基础键鼠操作。经典简体中文 Paint 支持原有绘图、文字和保存。新版中文 Paint 11.2605 已适配 120 DPI、100% 缩放、完整可见画布及展开工具栏，支持选笔、RGB、笔宽、连续路径和油漆桶填充；仅使用实际返回的 actions。不同版本、缩放、滚动与小图形误差都必须验收，不代表其他软件已有专用动作。

新版绘制闭合花朵轮廓可直接调用 `drawing.drawPolyline`，提供画布坐标 `points`、`closed:true`、`stroke:{color:[r,g,b],width:7}`，再用 `drawing.fillAt` 的 `position:[x,y]` 和 `color:[r,g,b]` 填内部。一次 execute_semantic 可提交多个动作。无需 Agent 编写键鼠脚本，程序负责选笔、设色、笔宽与回读。fillAt 使用真实油漆桶，调用者应确保轮廓闭合。新版暂不支持原生形状、文字、保存、图层操作或其他缩放；不要从经典 profile 借用未列出的动作。用户要求不保存时保留文档打开。

**不可用环境：** 没安装 Windows 版程序，或者程序不在目标应用的用户会话和输入桌面，无法正常发送输入。锁屏、断开的远程会话和受限执行令牌也可能造成失败。服务自动检查并返回原因；此时应修正启动环境，而不是反复点击。当前不承诺锁屏绘图或任意后台输入。

只有四个工具：

| 工具 | 做什么 | 什么时候用 |
|---|---|---|
| `list_windows` | 获取窗口列表 | 确定要操作的软件窗口 |
| `get_window_state` | 获取控件、截图、可用语义 profile 与动作示例 | 决定下一步，以及执行后验收 |
| `execute_semantic` | 根据 profile 执行一项或一批应用动作 | 有适合当前任务的语义动作时优先使用 |
| `execute_batch` | 执行一项或一批点击、填写、输入、按键、拖动、连续移动 | 没有适用语义动作时 |

工作方式：**明确完成标准 → 建立通讯并检查环境 → 确定目标窗口 → 获取状态 → 执行 → 获取新状态验收。**

减少工具数量不代表取消判断。程序负责自动检查环境、恢复焦点、管理状态；Agent 仍须读取检查结果、辨认目标、处理失败和核验任务。下文所有 JSON 输入都是工具参数，输出是字段示意；示例 ID、路径、坐标和结果文本必须替换成实际值。

开始前先明确：操作哪个应用/文档、需要改变什么、什么现象算完成。填写看字段是否精确等于目标值，提交看应用反馈，绘画看成品是否符合参考。用户要求不保存、不改窗口大小或使用指定工具时，整个流程都保留这些要求。

## 一、建立连接

### 已经有 MCP 工具

直接使用宿主提供的上述工具，宿主可能添加命名空间前缀。连接和 JSON-RPC 编号由宿主管理。先读取宿主显示的连接诊断：初始化响应中有实际执行 worker 的环境检查；任何输入前也会自动检查。看到 `ready:false` 或 `desktop_environment_not_ready`，停止动作，按下一节处理，不能认为“工具已连接，所以可以继续”。如果宿主不展示初始化响应，不编造 `ready:true`；正常调用仍受执行器检查，返回环境错误后立即转为诊断。

### 没有 MCP 工具

读取本 skill 目录下的 `installation.json`，找到 `root` 与 `executable`，确认路径存在。没有该文件时在用户指定仓库或 Release 中找 `bin/desktop-pilot.exe` 或 `build/core/Release/desktop-pilot.exe`。不要猜另一个项目的路径。

启动 `desktop-pilot.exe serve`，保持同一个服务进程，通过 stdin/stdout 交换下面的 JSON 消息。MCP 宿主或 Agent 选择的客户端负责收发；Agent 负责阅读响应并决定下一步，不需要套用固定的 PowerShell 判断脚本。

仓库也提供 `examples/onboarding/client.ps1` 作为可选通讯辅助：Open-Pilot 建立连接，Call-Pilot 调用工具，Close-Pilot 结束连接。Open-Pilot 保存初始化响应，但不会因 `ready:false` 自动抛错；Agent 仍须判断环境是否可用。

安装 skill 不等于安装程序或注册 MCP。若既无可用 MCP 服务也无 exe，报告缺少的程序/连接条件，不悄悄改用另一套电脑操作工具。

客户端直接启动 C++ 程序，只负责持久通讯，不需要 Node/Python。不要为每次调用重新启动程序，窗口和控件引用属于当前连接。操作多轮任务时，保持客户端会话，最后才关闭连接。

如果自己实现客户端，启动 `desktop-pilot.exe serve`，通过 UTF-8 stdin/stdout 每行发送一个 JSON-RPC 消息：

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-agent","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_windows","arguments":{}}}
```

收到 initialize 响应后先判断环境，未就绪时不继续发送任务动作；`notifications/initialized` 通知本身没有响应，不要等待它的回执。响应顶层 `error` 是协议错误，`result.isError:true` 是工具错误。正常工具数据读 `result.structuredContent`；`result.content` 的 text 通常是同一份数据，不重复输出两份。截图在 content 的 image 项，需实际查看图片，不能把 base64 当文本倾倒给 Agent。stderr 只放诊断，不混入 JSON。语义调用可能持续数分钟，客户端超时应超过 600 秒；附带客户端已处理。等待最终回执，不要由 Agent 高频轮询。

初始化中的环境检查示意：

```json
{"ready":false,"code":"desktop_environment_not_ready","reasons":["restricted_execution_token"]}
```

### 环境失败与重连

完整对象位于初始化响应的 `result._meta["desktopPilot/desktopPreflight"]`；附带客户端保存在 Initialization 中。

| 判断或原因 | 接下来做什么 |
|---|---|
| `ready:true` | 可以进入窗口定位；只证明环境检查通过，不证明控件、焦点、坐标或任务结果正确 |
| `ready:false` | 停止填写、点击、拖动、语义绘制；保留 reasons/session/nextAction，修正原因后重连 |
| ready 缺失或不是布尔值、`desktop_evidence_incomplete` | 没有得到充分诊断，不能当成 true；检查响应结构、宿主启动日志和程序版本 |
| `desktop_mismatch`、`desktop_name_mismatch` | 让执行器与目标程序处在同一 Windows 用户会话和输入桌面 |
| `restricted_execution_token`、`job_ui_restrictions` | 使用宿主允许的桌面执行方式；改坐标或加延迟无效 |
| `session_locked`、`input_desktop_unavailable` | 恢复可用的交互会话后重连，不把访问失败一概解释为锁屏 |
| exe 不存在、stdout 关闭 | 检查真实路径、退出状态及 stderr，不反复启动相同失败进程 |

**桌面都叫 Default、能列出窗口、能截图、用户本人能操作，都不能代替 ready 检查。** 用户能操作而 Agent 不行时，先排查执行环境，再查焦点、遮挡和控件行为。

环境异常时仍可用 `list_windows` 收集只读信息；已有目标可以尝试 `get_window_state` 的 `activate:false, mode:controls`，但查询也可能失败，不承诺锁屏截图。默认 get_window_state 会尝试激活，不能当成后台只读诊断。

修正启动环境后建立新连接，重新获取窗口和控件引用。CLI `doctor` 检查自身进程，MCP 初始化检查实际执行 worker；不要拿另一个进程的成功诊断覆盖当前服务错误。已有充分 MCP 诊断时不必再跑 doctor。

`jsonl` 子命令是底层开发协议，不接受这四个工具名；日常使用 `serve`。

## 二、找到窗口、获取状态

调用 `list_windows`，**不接受任何参数，直接列出全部窗口**。MCP 的 arguments 是空对象：

```json
{}
```

返回示意：

```json
{"status":"ok","windows":[{"window_id":"w1","title":"无标题 - 画图","pid":1234}]}
```

从实际结果确定目标。零项表示没找到；多项应根据标题/PID和任务辨认，不能默认第一项就是用户的窗口。一个进程也可能有主窗口与多个对话框。

Agent 根据返回的标题、PID 和任务上下文辨认目标，确定后使用它的 window_id。已经有列表就复用，不为了取 ID 重复枚举。一个 PID 可能对应多个窗口，不能直接取第一项。

没有目标时，先核对应用是否打开以及桌面是否一致。当前四工具没有独立启动应用动作；任务包含启动且宿主有已授权启动能力时，可以按真实路径启动一次，再列窗口。

随后调用 `get_window_state`：

```json
{"window_id":"w1","mode":"both"}
```

默认 `controls`，返回控件和语义信息；首次理解界面及发现语义动作使用 `both`。`image` 只截图，完全跳过 UIA 和 profile 扫描，返回 `semantic.status:not_checked`，空 profiles 不代表软件不兼容。默认恢复目标窗口焦点，不改变已有窗口大小。仅后台诊断时可用 `activate:false`。

返回内容示意（字段节选）：

```json
{
  "status":"ok","window_id":"w1",
  "coordinateSpace":"window_relative_physical_pixels",
  "size":{"width":1300,"height":850},
  "controls":[{"control_id":"e1","name":"标题","role":"Edit","value":"旧标题"}],
  "semantic":{"profiles":[],"unavailable":[]}
}
```

### 控件是否足够明确

`control_id` 来自本次返回。Agent 根据实际 `name`、`role` 和截图辨认目标：例如填写标题，应找标题字段；不能把遇到的第一个 Edit 当成它。多个候选时结合上下文继续判断；disabled 或 offscreen 控件先确认如何使其可操作。

`truncated:true` 表示控件列表不完整，不能据此判断目标唯一或不存在。结合截图定位，自绘区域使用观察到的坐标。当前四工具不提供任意局部 UIA 查询，不调用已删除的高级工具。

### 截图、坐标与状态变化

基础动作读取最近返回的 `coordinateSpace`：有截图时为 `image_pixels`，直接使用返回图片的像素坐标，程序自动映射缩放与裁剪偏移；仅 controls 时为窗口相对物理像素。不要加全屏偏移，也不要自行乘缩放倍数。`control_id` 不受图片缩放影响，控件 bounds 仍标明为窗口相对物理坐标。Paint 语义始终使用画布像素。

整窗截图最长边 1600 像素，默认 PNG（兼容所有模型宿主）；原分辨率文件保留在 `capture.originalPath`（发生缩小时）。需要检查文字、细线时用 `region:{x,y,width,height}` 请求局部截图，region 是窗口相对物理像素；局部默认无损编码，也有 1600 像素上限。确认宿主支持 WebP 时，在服务环境设置 `DP_IMAGE_FORMAT=webp` 以减少字节，无需修改动作。不得把文件变小直接等同于 token 降低。

通过附带客户端取到 capture.path 后，使用宿主图片查看能力打开实际文件；MCP 宿主则查看返回图片。不能只记录路径就声称看过截图。

| 状态 | 处理 |
|---|---|
| `foreground:false` | 默认状态获取和执行会尝试恢复焦点；若返回激活失败，查看环境/遮挡/弹窗，不循环发送激活动作 |
| 截图被遮挡、画布不可见 | 按实际界面处理并重新获取状态，不把遮挡窗口当作目标，不擅自最大化 |
| `window_blocked` | 读取返回的 blocking_window，用它的 window_id 获取对话框状态，不能把主窗口坐标发给弹窗 |
| 窗口移动、缩放或布局改变 | 重新获取状态；窗口不动也不能证明应用内部缩放、图层、选区、颜色未变 |
| 服务/worker 重启或窗口关闭 | 重新列窗口并观察，不构造或跨连接复用旧引用 |

执行器自动管理观察，但仍要求基础操作依据最近状态；基础批次执行后重新获取状态，不能重复使用已经消费的观察。

`controls`/`both` 返回的 `semantic.profiles` 列出当前匹配的 profile，每项含 `id`、条件说明、坐标说明和 `actions[].example`。不匹配原因在 `semantic.unavailable`。不应根据软件名猜 profile。

## 三、执行基础操作

基础操作直接描述鼠标和键盘事件，不依赖 profile。先掌握这些操作，再使用下一节的语义动作减少步骤。例如浏览器填写表单：

```json
{
  "window_id":"w2",
  "actions":[
    {"type":"fill_text","control_id":"e-title","text":"我的第一首歌"},
    {"type":"click","control_id":"e-submit"}
  ]
}
```

这是 `execute_batch` 的参数；只有一个动作也放进 `actions` 数组。

| type | 参数和效果 |
|---|---|
| `click` | `control_id` 或 `point:{x,y}` 二选一；`count:2` 表示双击 |
| `fill_text` | `control_id`、`text`；替换整个字段并回读验证 |
| `type_text` | `text`；向当前焦点输入文字，不保证替换原内容 |
| `press_keys` | `chord`，如 `Ctrl+A`、`Enter`、`Escape`、`F12` |
| `drag` | `from:{x,y}`、`to:{x,y}`；按住左键从起点直线拖到终点后松开 |
| `move` | `points:[[x,y],...]`；连续移动，可选 `hold:"left"` / `"right"` / `"middle"` 在整条路径期间按住鼠标键 |

### 连续移动与笔画

只移动到一个位置：`{"type":"move","points":[[120,180]]}`。按住左键画一条连续笔迹：

```json
{
  "window_id":"w1",
  "actions":[
    {"type":"move","points":[[100,200],[120,210],[150,205],[180,230]],"hold":"left"}
  ]
}
```

程序先移动到首点，再按下指定键，依次移动到剩余点，最后松开。省略 hold 时不按键；每个 move 都是完整动作，不把按住状态留给下一次调用。多条独立笔画用多个 move 项。

points 使用紧凑的 `[x,y]` 数组，不逐点重复 type、窗口、坐标字段名。接受 1–4096 点，指定 hold 时至少两点；只需给轨迹转折点，不必密集展开直线。坐标遵循最近观察的 coordinateSpace，必须位于该图片或窗口范围内。应用自己解释移动事件：画线需先选画笔/铅笔及颜色；拖动对象或悬停也可使用 move。

整条路径预检后按顺序发送，不为每个点插入固定等待，并禁止系统合并路径中的移动消息。应用仍可能按自己的方式采样或平滑，因此输入完成后检查实际笔迹。`delay_ms` 只表示整条动作开始前的等待，不是点间间隔。输入异常时执行器尝试释放鼠标键，已画出的部分不会撤销。

### 批次与验证

优先用 fill_text 替换可读字段。只有字段不适合 fill_text 且焦点已经明确，才使用点击/全选/type_text；type_text 不保证清空旧值，必须检查实际文本。快捷键传 Ctrl+A 等键名，文字和标点放在 text 中。

**基础批次以“不需要中途判断新界面”为边界。** 打开未知菜单/对话框后先观察，再发下一批；不能把其猜测坐标串进旧批次。语义适配器已经封装的菜单与弹窗可由程序内部处理，不要求 Agent 拆开同一语义动作。

每项可选 `delay_ms`，表示执行该项前等待 0–10000 毫秒，默认 0。只在界面确实需要响应时间时设置。一次支持 1–256 项；程序先检查参数，再顺序执行，逐项恢复目标焦点，首次失败即停止，不回滚。

不用填写或保存 `state_id`。执行器使用最近一次窗口观察，执行后再获取状态。窗口移动、控件改变或弹出模态窗口时会报告原因，防止对错误位置继续输入。不要把尚未观察到的新对话框操作写进同一基础批次。

成功示意：

```json
{"status":"ok","completed":2,"fieldsVerified":1,"verification":"business_result_not_verified"}
```

字段回读成功和点击派发成功，不证明业务提交完成。下一步仍然是获取新状态。

## 四、执行应用语义

### 原理：把意图转换为应用操作

基础操作说“点击这里、按下鼠标”；语义操作说“在这个位置画一个红圆”。**profile 是某一应用界面的适配配置**，描述适用条件、控件定位、坐标含义和已实现的动作；C++ 适配器据此把意图转换为具体操作。

例如 `drawing.drawCircle`：检查当前窗口与画布 → 选择椭圆工具 → 按需设置描边、填充和 RGB → 计算拖动位置 → 绘制并提交。Agent 提供几何和样式，不需要知道颜色对话框如何点击。程序复用同批次内已确认的控件和样式，并在失败时返回阶段和可用截图。

### 使用流程

1. 用 `get_window_state` 观察实际应用，读取 `semantic.profiles`。不凭软件名猜配置。
2. 读取匹配项的 `coordinates` 和 `actions[].example`，判断它是否支持当前任务。
3. 按示例组织 `execute_semantic` 的 actions。唯一匹配可省略 profile；多个匹配时明确选择返回的 id。
4. 程序重新验证窗口和 profile，校验参数，再执行整个批次。对已适配应用先修正可恢复条件并重新观察，不要看到 profiles 为空就立即拆成大量基础点击；确实没有适配或动作不支持时再使用基础操作。
5. 根据完成数和错误处理剩余任务，最后获取新状态验收作品或业务结果。

### profile 不匹配时先准备应用

先读 semantic.unavailable.reasons 和 actual，区分“当前布局不合适”与“软件不支持”。

| 原因 | 优先处理 |
|---|---|
| toolbar_too_narrow | 任务允许调整窗口时，加宽或最大化目标窗口，再获取状态；可用基础按键 Win+Up 最大化，不改画布尺寸 |
| control_not_unique:zoom | 根据实际缩放控件恢复 profile 要求的 100%，再观察；不是修改系统显示缩放 |
| window_minimized / window_blocked | 恢复目标窗口或处理实际对话框，再观察 |
| dpi_mismatch | 调整窗口宽度不会改变 DPI；需要支持该 DPI 的适配器，不冒充匹配、不改系统显示设置 |
| ui_inspection_incomplete / profile_inspection_incomplete | 兼容性尚未查清。读取 inspection 停止原因和计时；转 `mode:image`，根据可见证据使用基础操作，不原样重复扫描，不据此调整窗口 |
| 其他控件缺失 | 检查正确选项卡、弹窗和支持版本，按具体原因处理 |

用户明确要求保持窗口大小时遵守；用户已允许为适配调整窗口时直接处理，无需再次询问。修正一次后确认 profile 实际出现，再提交语义批次，不反复盲目尝试。没有可用语义能力，包括检查超时或 provider 故障时，都可以根据新截图使用基础操作。`referencesInvalidated:true` 表示 worker 已重启，必须先重新 `list_windows` 再截图，不能复用旧 ID。

### 怎样判断语义执行结果

批次在本地执行结束或遇到操作错误后返回，Agent 不需要逐点确认。`completed` 表示执行结束的动作数，`verification:scene_dispatched` 表示整批动作已发出，都不证明图形正确或好看。执行器不逐图形检查像素；整批完成后使用 `get_window_state` 获取画布截图，由 Agent 对照任务验收。

发生操作错误时读取 `failedIndex`、`failure.phase` 和局部截图；`dispatch:possibly_partial` 或 `retryable:false` 时不能直接重放失败动作或整个批次。密集多边形当前最多简化 1 画布像素，不适用于严格逐像素复刻。

### profile 协议：Agent 读取什么

`get_window_state` 返回的每个可用 profile 包含：

| 字段 | 含义与用法 |
|---|---|
| `id` | 已安装配置的标识，传给 execute_semantic.profile；不是路径 |
| `description` | 适用的软件界面和条件 |
| `coordinates` | 动作坐标的原点、单位、缩放要求，以及样式省略规则 |
| `actions` | 当前配置支持的动作目录 |
| `actions[].action` | 语义动作名，例如 drawing.drawCircle |
| `actions[].description` | 动作作用 |
| `actions[].example` | 可直接改参数使用的 `{action,args}` 示例 |

`semantic.unavailable` 给出相关配置未匹配的 id 和 reasons；profiles 为空时不能硬套配置。调用协议固定为 `{window_id, profile?, actions:[{action,args}]}`，其中 args 的具体字段由动作实现定义，不由 Agent 发明。

### profile 文件：中间层如何适配

配置保存在安装根目录 `profiles/<id>/profile.json`。`schemaVersion:1` 指定格式；`match` 声明进程、窗口类和必需控件，`selectors` 定义控件定位，`dpi` / `minimumWindowWidth` 等约束界面条件；`coordinates` / `actions` 是给 Agent 看的用法。执行器查找配置并校验当前窗口，Agent 日常调用只需 ID。

**profile 不是任意动作脚本。** 当前动作流程由 C++ 实现，JSON 提供定位和适配参数；添加一个动作名不会自动得到新功能。适配新软件需要对应执行代码和实测。完整文件字段、实际片段、加载规则和新增适配流程见安装根目录 [docs/SEMANTIC-PROFILES.md](../../docs/SEMANTIC-PROFILES.md)；独立安装的 skill 请按 installation.json.root 找到该文件。

### 调用示例

例如实际返回了经典中文版 Paint profile，且任务是画两个红圆后选择水彩刷，可在一批中表达：

```json
{
  "window_id":"w1",
  "actions":[
    {"action":"drawing.drawCircle","args":{"center":[80,80],"radius":24,"fill":[255,0,0],"stroke":{"color":[30,30,30],"width":1}}},
    {"action":"drawing.drawCircle","args":{"center":[150,80],"radius":24}},
    {"action":"drawing.selectBrush","args":{"brush":"watercolor"}}
  ]
}
```

唯一匹配时不必传 `profile`；多个匹配时，在请求中加 `"profile":"返回的id"`。即使显式指定，也会在执行前重新检查匹配条件。没有匹配时返回 `profile_not_matched`，不会强行套用 Paint 配置。

每个 profile 定义自己的动作和参数；直接参考返回示例，不要把 Paint 的参数套到其他应用。经典 Paint profile 允许 96/120/144 DPI 窗口，其中 120 DPI 已通过坐标模拟回归、待经典版实机验收；仍需匹配经典版 UI 控件；工具栏缩放与画布比例分开校准。位置是**画布像素**，不同于基础操作的窗口坐标。省略颜色/填充会沿用工具当前设置，`fill:null` 明确选择不填充。需要确定样式时，在首项指定；同批次复用已确认状态，避免反复选色。

一次提交整个稳定图形组，程序负责工具、菜单、RGB 回读、控件复用和内部等待。返回示意：

```json
{"status":"ok","profile":"mspaint-classic-zh-CN","completed":3,"total":3,"verification":"scene_dispatched"}
```

这表示操作完成派发，还要获取截图验收实际画面。刷子选择已包含在本次语义批次，不必先由 Agent 逐个打开菜单。保存需用户任务包含保存意图；`document.saveAs` 是另存新的 PNG，不覆盖已有文件。`drawing.drawPolyline` 现在用普通刷子和一次按住的 move 路径，省去逐段切换直线工具、按下和松开；同批次复用颜色与粗细。它保持传入路径，不自动把尖角变成曲线；圆形/椭圆仍用 Paint 原生形状工具，底层拖绘也通过 move。刷子、文字及几何参数详见安装根目录 `docs/SEMANTIC-PROFILES.md`。

### 绘图任务的准备和验收

用户要求在软件内画出来时，用应用的实际绘制动作；生成一张图片再导入，不等于完成该要求。先检查参考图的轮廓、构图、比例、色板，再安排图形或像素计划，不能把错误计划执行得很准确就称为画好。

在大量笔画前确认当前文档、画布尺寸、缩放、可见原点、图层/选区、画笔、描边、填充和颜色。通用基础绘制由 Agent 根据实际状态检查；已适配的语义操作把工具/颜色设置与回读交给中间层，但 profile 匹配并不代替作品验收。

同色同工具的一组动作可以复用设置；换工具、出现弹窗、失败或用户手动操作后，不假设旧样式仍有效。检查两个层面：执行后是否与计划的位置/颜色一致，以及作品是否与参考相似、有所要求的美感。像素任务按需读 [Aseprite 绘图指南](references/aseprite.md)，不要为每次表单任务读取绘图细节。

## 五、完整例子：Chrome 在 Google 搜索 AI，读取第一个结果

0. 按第一节建立连接并判断环境；本例假定 Chrome 已打开，下面是调用示例，不是实际搜索结果。
1. `list_windows {}`，根据标题和任务辨认目标 `window_id`。
2. `get_window_state {"window_id":"实际值"}`，确认这是目标 Chrome 窗口。
3. 该窗口没有适用语义 profile 时，用 `execute_batch`：

```json
{
  "window_id":"实际值",
  "actions":[
    {"type":"press_keys","chord":"Ctrl+L"},
    {"type":"type_text","text":"https://www.google.com/search?q=AI"},
    {"type":"press_keys","chord":"Enter"}
  ]
}
```

4. `get_window_state` 查看结果。如果仍在加载，稍后再获取状态，不重复发送搜索请求。遇到同意页面或验证页面，根据真实界面处理。
5. 先确认当前页面对应 Google 的 AI 搜索，再结合视觉顺序辨认结果；控件数组顺序不一定是页面顺序。默认区分广告、导航、AI 摘要和自然结果，用户指定口径时按用户要求。
6. 只读到摘要就说明是摘要，不编造正文或由标题猜网址。需要打开时，用新观察的链接控件或实际截图坐标点击，然后再次观察；新窗口需重新列出并确定目标。遇到网络错误、验证页或持续加载，设置等待截止时间并报告真实状态，不重复发送搜索。
7. 将实际读到的标题告诉用户。不会把输入成功当成“已查到结果”。

这套方法也适用于其它网站：先看状态，能用语义就用语义，否则把确定的基础动作放在一个批次，界面变化后再观察。

## 六、完整表单示例：连接、定位、填写、核验

前提：目标表单已打开。下面是 Agent 的调用和判断过程，不是要求生成固定脚本。示例 ID 与结果文本需替换成真实值。

1. 建立连接，读取初始化环境检查；ready:false 时先处理环境。
2. `list_windows {}`，从全部窗口的标题/PID 辨认目标。
3. `get_window_state {"window_id":"w1","mode":"both"}`，辨认标题输入框和 Apply 按钮。若候选不明确、控件不可用或列表截断，先结合截图确认。
4. 假设实际取得字段 e-title 与按钮 e-apply，调用 execute_batch：

```json
{
  "window_id":"w1",
  "actions":[
    {"type":"fill_text","control_id":"e-title","text":"Hello DesktopPilot"},
    {"type":"click","control_id":"e-apply"}
  ]
}
```

5. 读取批次回执。成功也要再调用 `get_window_state {"window_id":"w1","mode":"controls"}`，核对字段和应用反馈；本例读到完整的 `Applied: Hello DesktopPilot` 才算通过。
6. 页面还在处理时，有界等待后再观察，不重复点击 Apply。失败则按下一节判断哪些动作已经发生，只继续必要的部分。

## 七、错误处理与局部恢复

| 返回情况 | 下一步 |
|---|---|
| `desktop_environment_not_ready` | 修正服务启动会话/桌面/输入权限，再重连；不重试点击 |
| `unknown_window` | 当前连接重新列出窗口 |
| `state_required`、`geometry_changed`、`control_changed` | 获取新状态后重新定位 |
| `window_blocked` | 获取返回的 `blocking_window.window_id` 状态，按任务处理对话框 |
| `profile_not_matched` | 读 `semantic.unavailable`；修正适用条件或改用基础操作 |
| `profile_ambiguous` | 从返回的匹配项中明确指定 profile |
| 执行中失败或超时 | 看 `completed`、`failedIndex` 和局部截图；检查失败动作是否发生，只处理尚未完成部分 |

### 先分清是哪一类失败

工具响应中 `isError:true` 表示执行失败，具体原因在 structuredContent；顶层 error 表示协议错误。附带客户端的 Call-Pilot 会把工具错误抛为异常，Send-Pilot 可保留工具错误对象；通讯超时、stdout 关闭则先处理连接。Agent 根据实际返回判断，不把异常当成空结果继续操作。

批次错误示意：

```json
{"status":"error","code":"action_failed","completed":1,"failedIndex":1,"dispatch":"unknown","error":{"status":"error","message":"结果尚未确认"}}
```

| 字段/情况 | 意义及恢复 |
|---|---|
| completed:1、failedIndex:1 | 第一个动作完成，第二个动作失败或不确定；索引从 0 开始 |
| dispatch:not_started | 此次报告所指失败动作尚未派发，不代表此前整个批次没执行 |
| dispatch:unknown / dispatched | 可能已改变界面，必须先核验；不能直接从 failedIndex 重放 |
| error / failure | 基础批次通常在 error 内给原因；语义批次在 failure，复合动作还可能嵌套 |
| 缺少 dispatch 或 capture | 不据此推断未执行；截图仅在成功捕获时存在 |

例如“填写标题 → 点击 Apply”第二步失败：先看当前标题和 Applied 反馈。两者已经符合要求就结束；标题正确但应用反馈明确未更新时，使用新观察中的按钮只执行剩余点击；效果仍不确定时继续有界观察或报告阻塞，不整批重填重提。若失败返回模态窗口，先处理其实际状态。

**相同原因且没有新证据，不原样重跑任务。** 修复具体条件后才重试。客户端超时后可能仍有未完成的响应读取，当前 client.ps1 不保证这条连接可继续复用；结束/重建连接后重新枚举、观察实际效果，再决定剩余动作。取消或关闭客户端也不回滚已经发生的输入。四工具没有公开 requestId 去重参数，不要靠重用 RPC id 防止重复提交。

### 保留证据，避免为补报告重做任务

任务完成即停止动作。调试或测试时，把关键窗口状态、执行结果、失败对象和计时保存到本地文件，仅向 Agent 返回摘要；不要为了补日志再跑一遍绘图/提交。记录前后观察可以证明应用反馈，单个 status:ok 只能证明动作层结果。耗时注明是文件读取、程序执行还是 Agent 全程；没有实际计量时不报告精确 token。

## 八、注意事项与思考方式

- **先判断，再批量。** 先定完成标准；控件可读就用控件，自绘区域就看截图，有适配语义就用语义。界面需要重新理解时结束基础批次。
- **自动处理不等于不看返回。** 程序恢复焦点、检查环境、管理观察；Agent 要处理明确失败，不能认为下一步一定能继续。
- **保护任务现场。** 用户要求不改窗口大小，就不能为定位方便最大化；不保存时保留作品，不擅自保存、覆盖或关闭未保存文档。已有授权的正常步骤无需反复确认。
- **按需读取。** 字段验收优先 controls，画布和视觉布局优先 image，首次理解界面用 both。稳定笔画不逐笔截图；UIA 不完整时用 `mode:image` 补图；该模式不重跑 UIA。`both` 遇到可恢复查询错误仍返回截图和 inspection 错误，不能把空 controls 当成没有控件。不要因为 token 少而删掉完成任务必需的判断。
- **如实报告。** 区分计划、实际派发、字段回读、业务结果和作品质量。说明哪里失败、哪些已完成、哪些尚未验证，不把一处故障泛化为所有场景。

进一步阅读：本机参数以安装根目录 docs/AGENT-API.md 和实际 tools/list 为准；Skill 不是新增功能声明。独立测试可用 examples/onboarding/start.ps1 的 check/form/draw；这些练习会创建自己的测试窗口，不是每次实际任务的前置步骤。

更详细的连接问题见 [通讯说明](references/protocol.md)，具体故障见 [排查表](references/troubleshooting.md)。
