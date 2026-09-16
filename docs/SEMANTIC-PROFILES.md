# 应用语义与 profile

`execute_semantic` 把应用意图交给 C++ 中间层。例如画圆时，Agent 给出几何和样式，中间层完成工具选择、填充、RGB 回读、绘制和提交。一个语义批次只返回最终结果，减少 Agent 逐控件介入。

## 原理与操作流程

语义层由三部分组成：Agent 给出 `{action,args}` 意图，profile 描述适配哪个界面及如何定位控件，C++ 动作实现把意图转换为基础输入和检查。profile 本身不执行鼠标操作，也不是交给模型解释的点击脚本。

以画红圆为例，Agent 只提交圆心、半径、填充和描边；程序验证当前应用，定位画布和椭圆工具，按需设置颜色、填充、描边，换算坐标，拖动绘制并提交图形。同批次后续圆沿用已确认的设置；菜单和颜色框等已知界面由执行器处理。

1. list_windows 无参数列出全部窗口，Agent 辨认目标。
2. get_window_state 读取画面和 semantic.profiles；查看可用动作及其坐标说明。
3. 根据动作 example 组织参数。唯一匹配省略 profile，多项匹配指定返回的 ID；没有匹配先修正已报告的可恢复条件并重新观察，确认无法适配后再使用基础操作。
4. execute_semantic 重新检查 profile，校验全部动作参数，然后执行；失败即停止，不回滚已完成内容。
5. 读取 completed、verification 或 failure，再获取新状态核验实际效果。派发完成不等于画面正确。

基础操作和语义操作可以交替使用，但不能混在同一 actions 数组：基础项用 type，语义项用 action/args。例如语义选择水彩刷之后，重新观察，用 execute_batch 的 move 路径绘制自由笔迹。

## 根据实际窗口选择

先获取 `get_window_state`，读取 `semantic.profiles`。每项含 id、description、coordinates 和 actions 的完整调用示例。当前程序从 `profiles/<id>/profile.json` 读取已安装配置。

- 按进程文件名匹配应用，按窗口类与 UI 控件指纹区分界面；同时检查 DPI、工具栏宽度、关键控件唯一性和可见性。
- 填充、轮廓按钮在刷子模式下正常禁用，因此不作为入口必须可用的控件；形状执行会先选择工具再设置这些选项。
- 只有通过检查的项进入 profiles；相关但不满足条件的项进入 unavailable，包含原因。
- 唯一匹配可省略 profile；多个匹配要明确指定；没有匹配先看原因；窗口宽度、缩放、工具栏等可恢复条件，在任务允许时先修正并重新观察，再考虑基础操作。DPI 不匹配不能靠放大窗口解决。
- execute_semantic 在执行前重新匹配，显式指定 ID 也不能跳过检查。不会把 Paint 配置用于 Aseprite。
- 这不是完整版本号认证；符合指纹仍需由具体动作检查布局和绘图结果。未滚动画布等条件目前仍需结合截图确认。

默认从 exe 所在目录及上级安装目录查找 profiles，源码构建和 Release 布局都支持。可用环境变量 `DESKTOPPILOT_PROFILES_DIR` 指定完整目录；配置后只读取该目录。MCP 只接收 profile ID，不接收文件路径。

## 当前 profile

`mspaint-classic-zh-CN`：经典简体中文 Paint，进程 mspaint.exe、窗口类 MSPaintApp，应用报告 96 或 144 DPI，窗口宽度至少 1100、画布 100% 缩放、关键中文工具栏控件可访问。要求画布未滚动，图形处于可见画布内。系统显示缩放由工具尺寸校准，不能据此声称任意版本、任意缩放兼容。

状态为实验性：历史实测存在 1 像素栅格舍入误差，尚未完成所有动作的逐像素位置、尺寸、描边验收。语义派发成功不等于艺术质量或像素精度达标。

## 调用例子

以下为 execute_semantic 参数，window_id 使用当前返回值；假设已经确认该窗口匹配 Paint：

```json
{
  "window_id":"当前窗口ID",
  "profile":"mspaint-classic-zh-CN",
  "actions":[
    {"action":"drawing.drawCircle","args":{"center":[80,80],"radius":24,"fill":[255,0,0],"stroke":{"color":[30,30,30],"width":1}}},
    {"action":"drawing.drawCircle","args":{"center":[150,80],"radius":24}},
    {"action":"drawing.drawText","args":{"position":[40,130],"size":[240,60],"text":"Hello","stroke":{"color":[30,30,30]}}}
  ]
}
```

位置都是画布像素。`fill` 省略不设置填充，`fill:null` 明确不填充，RGB 数组明确填充颜色。`stroke` 或其 color/width 省略时不修改对应属性。工具切换可能有自己的默认样式；需要确定外观时显式指定，程序仍会跳过同批次中已经确认的重复设置。

## 连续路径与形状绘制

所有形状的底层拖绘改用 input.move 的 points + hold:left。圆、椭圆、矩形保留原生形状工具，由 Paint 自己生成边缘；多边形仍按原生工具的顶点流程完成。

`drawing.drawPolyline` 从“多条独立直线”改为“普通刷子的一次连续路径”：定位画布、选择普通刷子、按需设置颜色/粗细，在首点按下，经过中间点并在末点松开。绘制阶段只有一次输入调用，同批次相同样式可复用。此动作选择普通刷子，不沿用此前选择的水彩/喷枪。

它不会自动平滑尖角或对像素边缘抗锯齿。需要曲线时提供合适的曲线采样点；需要规则圆形时使用 drawCircle/drawEllipse。move 减少的是重复落笔接缝和 Agent 往返，不代表改变 Paint 的渲染能力。

144 DPI 的 DPI-aware Paint 在 100% 缩放下画布仍为一文档像素对应一屏幕像素；工具栏放大 1.5 倍不能用于放大图形。执行器将 UI 缩放与画布缩放分开：UI 尺寸校准负责画布边框 inset，画布倍率为 UI 校准倍率 × 96 / 窗口 DPI。

## 动作和参数

| action | args |
|---|---|
| drawing.drawCircle | center:[x,y]、radius:2..8000；可选 fill、stroke |
| drawing.drawEllipse | position:[x,y]、size:[w,h]；可选 fill、stroke |
| drawing.drawRectangle | position、size；可选 fill、stroke |
| drawing.drawRoundedRectangle | position、size；可选 fill、stroke，圆角由应用决定 |
| drawing.drawLine | from:[x,y]、to:[x,y]；可选 stroke |
| drawing.drawPolygon | points:[[x,y],...]，3–128 个顶点，自动闭合；可选 fill、stroke |
| drawing.drawPolyline | points，2–4095 个点；可选 closed、stroke；一次普通刷子的连续笔画，闭合时末尾追加首点 |
| drawing.drawText | position、size、text；可选 stroke.color |
| drawing.selectBrush | brush，见下表 |
| document.saveAs | path:绝对路径、新 .png 文件；可选 format:"png"、overwrite:false |

position 为包围框左上角，size 每项至少 2。坐标范围 0..32000，形状不能超出可见画布。线段端点不可相同；多边形不得退化、重复相邻顶点或重复首尾顶点。stroke.color 与 fill 都是 0..255 的三通道 RGB；stroke.width 支持 1、3、5、8。

文字先创建文本框，再替换并回读文本，最后退出文本模式。沿用应用当前字体，不支持指定字体、字号、加粗或文本背景；传入不支持的文字参数会报错。

brush 可取 `brush`、`calligraphy1`、`calligraphy2`、`airbrush`、`oil`、`crayon`、`marker`、`pencil`、`watercolor`。只选刷子，不绘制笔迹、不更改颜色。通过菜单定位并回读画布的工具名称确认。

另存为会打开原生对话框、填写绝对文件名、确认保存并解码 PNG 验证文件。父目录必须存在；不覆盖已有文件。没有保存任务时不提交保存动作。

## 批次、复用与失败

actions 可混合图形、文字、刷子选择和保存，最多 256 项。所有参数在首个语义输入前校验；运行时的控件/文件变化仍可能使后续项失败。外层 profile 匹配是只读检查，获取窗口状态和执行入口可自动激活窗口。

连续图形共用布局、控件定位及样式状态。用户介入、窗口变化、工具变化或不兼容的动作会使相关缓存失效。文字、刷子或保存导致界面变化时重新定位。连续路径复用普通刷子及颜色/粗细，不再展开成独立直线；切换到其他形状工具时重新确认样式。

失败停止、不回滚、不自动重试绘制。结果包含 completed、failedIndex、failure；失败设置阶段尽量捕获当前窗口/弹窗，绘图阶段尽量捕获局部区域。MCP 自动附图。若截图失败，保留原始错误并返回 captureError。

成功的 verification 描述的是派发/字段回读/文件解码等具体证据，不是整体作品验收。最后获取截图，比较位置、轮廓、颜色与用户目标。

## 开发适配

### Agent 看到的协议

get_window_state 的 semantic 对象返回 status、profiles、unavailable。profiles 的元素只公开 `id`、`description`、`coordinates`、`actions`；不会要求 Agent 读取内部定位细节。actions 的每一项有 action、description、example，example 形状是 `{action,args}`，可以直接填入 execute_semantic.actions。

unavailable 的元素包含 id 和 reasons，例如 dpi_mismatch、toolbar_too_narrow、ui_inspection_incomplete、control_not_unique:canvas。其他可执行程序的配置直接略过，不列入相关配置的失败原因。目录不存在时 profiles 为空，reason 为 profiles_directory_missing。

当前目录提供调用示例，不提供每个动作的 JSON Schema。参数范围由 C++ 动作解析器校验，使用者按本文动作表和实际 example 填写；不能把示例里没出现的功能视为支持。

### profile.json 文件协议（schemaVersion 1）

| 字段 | 类型与职责 |
|---|---|
| schemaVersion | 整数，当前必须为 1 |
| id | 字符串，必须与目录名一致；字母、数字、连字符、下划线、点，不允许路径或单独的点 |
| description | 字符串，向 Agent 说明适用界面和限制 |
| coordinates | 字符串，向 Agent 说明原点、单位、缩放与参数省略规则 |
| match.executable | 进程文件名，忽略大小写比较，如 mspaint.exe |
| match.className | 顶层窗口类名，精确比较，如 MSPaintApp |
| match.requiredSelectors | selectors 中的键名数组；完整 UI 查询中每个必须恰好匹配一个可用且可见控件 |
| dpi / supportedDpi | dpi 是旧配置的单值；提供 supportedDpi 数组时以其中允许的值为准。当前 Paint 为 [96,144]，并在执行时校准工具栏尺寸与画布比例 |
| minimumWindowWidth | 窗口物理像素宽度下限，避免工具栏折叠导致布局不匹配 |
| selectors | 命名控件定位对象；nameContains 为包含匹配，其余键如 name/role/automationId 为精确匹配 |
| actions | 动作目录数组，每项含 action、description、example；只列 C++ 已实现并经适配的动作 |
| 适配器专属字段 | 当前 Paint 还使用 referenceToolSize、canvasInset、菜单选项、RGB 字段、brushes、save、clickSettleMs 等；按实际实现定义，不是通用操作指令 |

匹配器还检查窗口未最小化、未被禁用，以及控件查询未截断。达到这些条件只代表可尝试适配动作，不能证明绘图精度或作品质量。

下面是当前 Paint 配置的结构片段，**用于说明字段关系，省略了动作执行所需的其他控件和选项，不能作为完整配置安装**：

```json
{
  "schemaVersion":1,
  "id":"mspaint-classic-zh-CN",
  "description":"经典简体中文 Paint",
  "coordinates":"画布像素，100% 缩放、未滚动",
  "dpi":96,
  "minimumWindowWidth":1100,
  "match":{"executable":"mspaint.exe","className":"MSPaintApp","requiredSelectors":["zoom","canvas","ellipse"]},
  "selectors":{
    "zoom":{"name":"100%","role":"Text"},
    "canvas":{"nameContains":"画布","role":"Pane"},
    "ellipse":{"name":"椭圆形","role":"ListItem"}
  },
  "actions":[{
    "action":"drawing.drawCircle",
    "description":"圆形",
    "example":{"action":"drawing.drawCircle","args":{"center":[80,80],"radius":24,"fill":[255,0,0]}}
  }]
}
```

完整可执行配置见 [实际 profile.json](../profiles/mspaint-classic-zh-CN/profile.json)，不要从片段推测缺失字段。运行时先按安装 ID 加载，再按当前窗口匹配，动作名称还需出现在该配置目录中；显式给定 ID 不会跳过匹配。

### Paint 执行与验收

`recommendedWindow` 提供新建窗口的推荐尺寸（`units: dpi96`，由运行时按 DPI 换算并限制在工作区内）。内部 `app.launch` 会尝试准备刚启动的匹配窗口；读取已有窗口不会自动改变它的尺寸。查询控件超时、截断与 DPI 不匹配分别返回原因，不能一律通过放大窗口解决。

执行器不逐图形截取和抽样检查像素。`completed`、`verification:scene_dispatched` 只报告动作执行情况，不代表图形正确。整批执行后由 Agent 获取画布截图，对照参考检查完整结果。

密集多边形会先以最多 1 画布像素的偏差简化冗余顶点，并从最长边开始绘制，降低经典 Paint 短起始边导致图形消失的风险。仍有约 47×40 像素花瓣只留下部分图形的已知失败，不能声称任意多边形可靠或逐像素一致；复现数据见 `tests/fixtures/paint-small-petal-known-failure.json`。连续自由线仍使用按下、连续移动、松开的路径输入。批次保留样式与控件定位；省略样式字段时沿用已知状态。

操作失败结果包括已执行数量、失败阶段和局部截图。绘图已经开始时，返回可能部分执行，不自动重放整幅画。仅因绘制外观不符合预期而中断批次的像素检测已撤销。

支持 Invoke 的标准控件可通过 UIA 直接调用；画布输入仍需目标窗口可交互，并由运行时处理激活和遮挡检查。此机制不承诺任意应用后台键鼠输入，也不会自动关闭未知模态对话框。

### 新增适配的步骤

1. 用目标应用的实际窗口状态确定进程、窗口类、DPI、控件结构及坐标规则，选取能区分支持布局的控件指纹。
2. 在 profiles 下建立独立目录和 profile.json，填写匹配条件、定位配置和准确的动作示例。
3. 实现或扩展 C++ 适配器，包括参数验证、定位、动作执行、等待/回读、批次复用和失败返回。当前分派由 profiles.cpp 进入 semantic.perform，再由语义实现执行；manifest 没有动态脚本或插件入口。
4. 验证不匹配窗口会被拒绝，支持窗口能执行，并测试中途失败、设置变化和实际结果。绘图还需对照位置、尺寸、颜色，不能仅检查 status:ok。
5. 同步示例和文档，部署配置及包含对应代码的程序。使用新状态重新发现 profile，再执行。

当前执行器是已实现动作的 C++ 适配器，不是任意 JSON 配方解释器。增加另一类软件需要实现适配器、动作参数验证、实际控件匹配和结果测试；单纯改 profile 的名字不能获得新软件能力。配置示例应与代码和 UI 实测一起维护。
