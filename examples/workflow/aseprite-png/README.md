# Aseprite 单帧 PNG 批次示例

先从少量副本试跑。将 `.ase` 或 `.aseprite` 文件放到 `input/`，修改 `workflow.json` 中的 `executable` 为本机 Aseprite 路径。输入目录中的所有文件都会进入清单，说明、配置和脚本应放在外面。

从仓库根目录执行（首次使用先 `npm ci --prefix node`）：

```powershell
npm run build --prefix node
$config = 'examples/workflow/aseprite-png/workflow.json'
$script = 'examples/workflow/aseprite-png/decide-item.mjs'
$runDir = 'workflow-runs/first-batch'
node node/dist/src/workflow/cli.js validate $config
node node/dist/src/workflow/cli.js plan $config
node node/dist/src/workflow/cli.js run $config --run-dir $runDir --trusted-script $script
node node/dist/src/workflow/cli.js status $runDir
```

每次新批次使用尚不存在的运行目录。产物在 `$runDir/artifacts/`，逐项结果在 `$runDir/report.json`；源文件不覆盖。空输入目录会被拒绝。复制示例到其它位置后，调整命令中的配置和脚本路径；配置内部的相对路径以配置文件位置为基准。

示例脚本跳过 `_reference` 子目录中的受支持素材。先阅读脚本再显式传入 `--trusted-script`；这是具备当前用户权限的本地代码。`validate` 和 `plan` 不导入它。无需动态规则时删除配置的 `script` 字段，并省略 `--trusted-script`。

支持单帧、最多 1600 万像素；多帧和其它格式列为不支持。PNG 检查覆盖完整解码、尺寸及透明通道证据，不保证任意图片内容等价。完整命令、退出码与异常恢复方法见 [Workflow 使用指南](../../../docs/guides/WORKFLOW.md)。保留整个运行目录以便恢复或核对，勿清理尚未核对的候选文件。
