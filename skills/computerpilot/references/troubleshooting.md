# ComputerPilot 故障处理

先看结果中的 code、message、next 和实际截图，不根据单一现象猜原因。

| 现象 | 处理 |
|---|---|
| 找不到程序 | 读取 installation.json 并确认路径；skill 本身不是可执行程序 |
| ready:false / desktop_environment_not_ready | 程序必须与应用同一 Windows 用户会话及输入桌面，且允许输入。按 reasons 修正启动环境后重连；不要重试点击。锁屏和隔离桌面问题不能靠窗口标题或截图绕过 |
| list_windows 返回空数组 | 检查应用是否已打开，以及程序是否处在同一个桌面；list_windows 无参数，直接列出全部窗口 |
| unknown_window | 重连或 worker 重启后重新列举，不复用旧引用 |
| state_required | 获取目标新状态；一次批次结束后旧观察已消费 |
| geometry_changed / control_changed | 窗口或控件变动，重新观察和定位 |
| window_blocked | 看 blocking_window，观察并处理实际模态对话框 |
| window_activation_failed | 系统未允许恢复目标焦点；检查输入桌面、模态窗口和权限，不向其它前台窗口继续输入 |
| profile_not_matched | 看 semantic.unavailable；不同程序/版本/语言、DPI、工具栏宽度或缩放可能不兼容。对窗口过窄、缩放不符等可恢复条件，任务允许时先调整应用并重新观察；DPI 错误需适配代码支持，放大窗口无效；确认无法匹配才回退基础操作 |
| profile_ambiguous | 从 semantic.profiles 明确传一个 profile ID，仍会重新验证 |
| action_not_supported | 使用当前 profile 返回的动作示例，不猜接口 |
| 颜色/工具设置失败 | 看失败截图和 phase，修正具体控件条件；不要重画已完成形状 |
| 超时或连接断开 | 动作可能已发生。检查实际结果，再处理剩余部分；不要自动重放整个任务 |
| 输入回执成功但效果不对 | 回执不等于结果。检查实际字段、画面、缩放、选区、工具与任务要求 |

完整错误对象可能位于基础批次的 error，或语义批次的 failure。completed 表示已完成项；failedIndex 为从 0 开始的失败项。局部截图只在成功捕获时提供，captureError 不应覆盖原始故障。

## 常见误判

- Open-Pilot 正常返回：仅代表连接建立；必须另读保存的 preflight.ready。
- 控件数组只有一个 Edit：truncated 时不能证明唯一；完整表单还需按实际字段名称辨认。
- 两个桌面都叫 Default：名称相同不证明是同一个可输入桌面；能截图也不能覆盖未就绪诊断。
- 图像查看器里点位正确：缩略图坐标要还原到原始窗口物理像素；语义画布像素另算。
- completed 为 1：不代表失败的第二项没生效；读取当前业务结果后才决定剩余操作。
- 同样动作重跑成功一次：不证明先前失败未发生；保存首轮日志，不为补报告重复提交。
- 图画得跟计划一致：仍需检查计划本身与参考图的轮廓、比例、颜色和美感是否吻合。

完整判断示例和错误处理分支在 [Skill](../SKILL.md) 中。若没有新证据，相同错误不要原样重试。
