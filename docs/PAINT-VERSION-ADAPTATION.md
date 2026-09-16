# Paint 版本适配研究

更新：2026-09-17。经典 120 DPI 修复及新版首批适配已实现。新版 `mspaint-modern-zh-CN` 已在 11.2605.81.0、120 DPI、100% 缩放下实测连续闭合路径和 RGB 区域填充。以下保留版本研究依据；未列入新版 actions 的能力仍属后续工作。

## 已完成的 DPI 修改

经典中文 profile 的 supportedDpi 从 [96,144] 改为 [96,120,144]。没有修改 Windows 显示缩放，没有取消 UI 指纹校验。现有 C++ 逻辑已经分离工具栏倍率和画布倍率，无需另加一套 120 DPI 坐标公式。

现有公式：uiScale = 椭圆工具实际宽度 / referenceToolSize；canvasScale = uiScale * 96 / windowDpi。对 DPI-aware、100% 画布的 120 DPI 窗口，uiScale=1.25，canvasScale=1；画布内坐标不再乘 1.25，边框 inset 按 UI 倍率取整。该公式依赖经典工具尺寸，不能直接作为所有新版 Paint 的校准方法。

新增模拟测试覆盖：120 DPI 配置匹配；同 DPI 下错误 UI 指纹仍拒绝；圆的起点、终点、直径及 inset 舍入；闭合连续路径的所有端点。保留既有 96 DPI 虚拟化 1.25 倍与 144 DPI 测试。cmake --build --preset core-only --parallel 4 构建成功，ctest --preset core-only -LE interactive 全部 17 项通过。

限制：未对经典版 Paint 的 120 DPI 进行实机圆形/像素验收。当前机器运行的新版不能代替经典版实测。

## 当前机器的证据

- 正在运行的 mspaint.exe 文件版本：11.2605.81.0；位于 Microsoft.Paint_11.2605.81.0_x64__8wekyb3d8bbwe 包内。
- DesktopPilot 观察到窗口 DPI=120、宽度=2578。修改前唯一报告原因为 dpi_mismatch；该阶段尚未扫描 profile 所需控件，不能从这个原因推断 UI 兼容。
- 当前画布为 1000×1000，屏幕物理 bounds 为相对窗口 (788,283,1000,1000)，缩放显示 100%。此状态支持该窗口下文档像素与物理像素 1:1，但不是其他缩放状态的证明。
- 画布名为“在画布上使用 画笔 工具”，返回 role=50026（UIA Group），而经典配置要求 Pane。
- 缩放有 ComboBox、屏外 Edit(value=100%)、Slider(value=100 百分比)；经典配置要求可见 Text(name=100%)。不能为兼容而接受屏外 Edit。
- 画笔“大小”与“不透明度”均为 Slider；经典粗细菜单及 1/3/5/8 的配置不能直接套用。
- 顶部有“颜色”“形状”“层”等组。本次公共状态未暴露经典版所需的椭圆 ListItem、颜色 1/颜色 2 按钮等完整子控件。不等于断言新版完全没有 UIA 支持；需要进一步比较 RawView/ControlView、焦点及折叠状态。
- 前次绘图实测颜色编辑器位于主窗口内，提供 RGB 数值和 RGB 十六进制 Edit；经典实现的单独对话框及 automationId 706/707/708 不能直接移植。
- 上述检查没有修改或关闭现有四朵花文档。

## 如何区分版本

按界面能力分族，文件版本记录在诊断中；不要只依靠 Windows 10/11 标签、mspaint.exe 名称或顶层窗口类。

| 界面族 | 识别证据 | 策略 |
| --- | --- | --- |
| 经典 Ribbon 中文版 | 唯一且可见的 Pane 画布、100% Text、椭圆 ListItem、颜色 1/2、刷子菜单 | 保留现有 classic profile；验证 96/120/144 DPI |
| Windows 11 早期或其他中间布局 | 有独立版本样本，但不能预设它与经典/新版完全一致 | 采集实际控件树及动作回执；指纹和动作流程一致才复用适配器 |
| 当前现代版 11.2605.81.0 | Group 画布、缩放组合控件与 Slider、大小/不透明度 Slider、层及新的颜色编辑器 | 新建 modern 适配器与独立 profile；不能复制经典配置后只改 DPI |
| 未知/以后更新 | 必需控件缺失、冲突或校准失败 | 返回具体原因；保持基础键鼠可用，不强行派发语义动作 |

Microsoft 的 Paint 发布记录显示工具栏、画笔、图层等仍在更新。因此版本号适合标注已验证范围，实际控件/功能指纹才决定是否可执行。

## 建议的代码改动顺序

1. 补足观察证据。在 desktop_windows.cpp 中为 Group、Slider 等 UIA controlType 提供易读名称；保留 controlType 数值。内部开发探针比较 ControlView 与 RawView，记录 automationId、框架、可见性、层级和支持的 Pattern。不要先无限提高查询深度或把未发现解释成应用不支持。
2. 区分执行器。当前 profiles.cpp 最终交给 semantic.perform，semantic.cpp 和 semantic_actions.cpp 含经典 Paint 专属操作。新增明确 adapter/strategy 分派（例如 paint-classic、paint-modern），校验未知 adapter，不把 profile 当任意 JSON 点击脚本。
3. 建立现代控件定位。优先 automationId + controlType + 父级范围，中文名称作为辅助；只有样本证明稳定才记录选择器。组内按钮缺失时先解决观察能力，坐标兜底必须绑定可见组 bounds、布局指纹与校准结果。
4. 建立 CanvasTransform：文档坐标 → 可见画布物理坐标 → 窗口物理坐标。单独读取画布缩放及滚动/可见原点；不从工具栏图标大小推断现代画布倍率。首版可明确只支持 100%、未滚动、目标在可见区。
5. 现代样式流程按实际控件实现。Slider 优先 RangeValue Pattern 并回读；颜色编辑器支持主窗口内弹层；填充/描边与主次色含义按实际行为验证。关闭弹层后重新观察，避免一次点击落入画布。
6. 按能力逐项开放。先选笔、颜色、粗细、连续路径，再接原生形状与填充。图层、文字和保存单独验收后才加入 actions。保存需区分 PNG 与可编辑工程格式。
7. 状态缓存必须包含 DPI、窗口 bounds、布局、画布缩放/原点、活动层与工具。窗口跨屏、工具切换、弹层关闭等使缓存失效。截图刷新和 UIA 状态就绪分别检查，避免使用旧画面定位。

不要仅删除 DPI 白名单：当前既有控件取整，也有版本布局差异。先按已验证值允许执行，再逐步用可验证的几何/能力条件替代硬编码值。

## 验收矩阵与完成标准

- 经典版与当前现代版分别使用新建、可丢弃文档；不借用用户未保存的作品做测试。
- 96/120/144 DPI 必测，192 DPI 作为新增支持候选；未实测不标兼容。窗口宽度覆盖正常与折叠状态。
- 100% 画布先验收；50%/125%/200% 和滚动画布先验证正确拒绝，之后再逐项开放。
- 圆/矩形检查文档像素位置、尺寸和填色；路径检查所有顶点、闭合与粗细；颜色检查 RGB 回读和实际结果。
- UI 指纹缺失、重复、查询截断、未知 adapter、弹窗阻挡必须在输入前拒绝。失败后不重放已完成笔画。
- 坐标误差应记录实际值；不能将输入派发成功作为像素/视觉验收。

首批交付：`src/semantic_modern_paint.cpp` 与独立 modern profile。动作包括 selectBrush（brush/pencil）、setColor、setStrokeWidth（1..24、26、28、30）、drawPolyline、fillAt。使用真实 Paint 键鼠/UIA 操作，不导入生成图片。全部场景参数先校验；每次绘图前重新验证画布边界和 100% 缩放。RangeValue 笔宽为从 0 起的索引，按分段索引写入 并回读“n 像素”。颜色弹层只扫描直属字段，避开自定义色块列表的循环 sibling。原生圆/矩形、文字、保存、其他 DPI 与非 100% 缩放尚未开放。

## 本次实际验收（2026-09-17）

- `ctest --preset core-only -LE interactive`：18/18 通过，新增 modern-paint 覆盖 DPI 坐标、整批参数校验、非 100% 拒绝、笔宽回读失败、越界及部分笔画不重放。
- 使用安装后的可执行文件通过公开 MCP `execute_semantic` 实测；初始化 ready=true、自动发现 modern profile。测试文档 PID 20640，与既有作品 PID 5076 分开。
- 连续闭合黑色路径 + 粉色填充首批完成 2/2；选铅笔/画笔、1 像素设置成功。发现大笔宽非线性后修正索引：0..23 对应 1..24 像素，24/25/26 对应 26/28/30。
- 最终批次完成 5/5：30 像素设置、7 像素黑轮廓与蓝色填充、7 像素绿轮廓与黄色填充。截图已查看，位置、闭合、填充区域符合测试目标；回执仅声称设置回读及动作派发，未将截图检查包装成自动像素判定。
- 未保存测试文档，未修改既有花朵作品。现代版其他 DPI、其他缩放、原生形状与保存仍未开放。

## 参考资料

- 本地实现：src/profiles.cpp、src/semantic.cpp、src/semantic_actions.cpp、src/desktop_windows.cpp。
- Microsoft UI Automation 屏幕缩放说明：UIA BoundingRectangle/GetClickablePoint 使用物理坐标，应避免二次 DPI 换算。https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling
- Paint 官方更新记录（查阅 2026-09-16）：https://learn.microsoft.com/en-us/windows-insider/release-notes/apps/paint
- Paint 图层与透明度官方说明：https://blogs.windows.com/windows-insider/2023/09/18/paint-app-update-adding-support-for-layers-and-transparency-begins-rolling-out-to-windows-insiders/
## 安装后实机复核

已将通过测试的 profile 同步到 DesktopPilot-release-v0.4.0/app/DesktopPilot/profiles/mspaint-classic-zh-CN/profile.json，源文件与安装文件 SHA-256 一致。安装配置和本机 skill 保留 .before-120dpi.bak 备份；此次仅配置/说明变更，不需要替换运行中的 exe。

复核时原窗口引用失效，窗口列表中原 PID 14056 已不存在；本次操作未发送关闭该文档的指令。随后通过 cmd 启动画图，仅读取新窗口状态，没有绘制或保存。

新窗口在 120 DPI、宽 1708 下不再返回 dpi_mismatch。内部 profile 查询 visited=174、truncated=false、stopReason=complete，拒绝原因为：control_not_unique:zoom、canvas、ellipse、primary、secondary、brushMenu。这是 DPI 放行后仍保留版本隔离的实机证据，不是现代绘图成功证明。

新窗口的公共控件列表出现“椭圆” ListItem(28×28)及其 Button(25×25)，而经典选择器为“椭圆形”。其外层列表项尺寸不能直接除以经典 referenceToolSize=20 推算现代画布：28/20=1.4，在 120 DPI 会产生错误倍率。应使用独立现代画布变换。

新窗口同样暴露“画笔” SplitButton(role=50013)、“填充” Button 等更多子控件。此前窗口列表未出现这些子项，因此不能断言新版没有 UIA；应研究实例状态/布局造成的差别。公共列表本次 truncated=true，但上述内部 profile 匹配查询完整，这两个查询的完整性必须分别解释。
