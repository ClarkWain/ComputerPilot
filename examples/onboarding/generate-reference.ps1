param([string]$Executable,[switch]$Check)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$schemaPath=Join-Path $root 'node/src/mcp/tools.json'
$raw=[IO.File]::ReadAllText($schemaPath,[Text.Encoding]::UTF8)
if($Executable){
    $legacyRaw=(& $Executable agent-schema) -join "`n"
    if($LASTEXITCODE -ne 0){throw 'agent-schema failed'}
    $legacyTools=$legacyRaw|ConvertFrom-Json
    $currentTools=$raw|ConvertFrom-Json
    foreach($tool in $legacyTools){$tool.description=''}
    foreach($tool in $currentTools){$tool.description=''}
    $legacy=($legacyTools|ConvertTo-Json -Depth 100 -Compress)
    $current=($currentTools|ConvertTo-Json -Depth 100 -Compress)
    if($legacy -cne $current){throw 'Legacy C++ schema differs from Node source'}
}
$tools=$raw|ConvertFrom-Json
$lines=[Collections.Generic.List[string]]::new()
$lines.Add('# 常用 Agent 接口参考（自动生成）')
$lines.Add('')
$lines.Add('来源：node/src/mcp/tools.json。不要手工修改参数表。重新生成：examples/onboarding/generate-reference.ps1。首次上手先读 MCP.md；此文件仅供查参。')
$lines.Add('')
function Add-Fields($Schema) {
    if (@($Schema.properties.PSObject.Properties).Count -eq 0) { $lines.Add('无参数；传空对象 {}。'); $lines.Add(''); return }
    $lines.Add('| 字段 | 必填 | 类型/取值 |')
    $lines.Add('|---|---|---|')
    foreach($p in $Schema.properties.PSObject.Properties){
        $v=$p.Value
        $kind=if($v.enum){$v.enum -join ', '}elseif($null -ne $v.const){[string]$v.const}elseif($v.oneOf){'oneOf: 见动作表'}else{[string]$v.type}
        $required=if($Schema.required -contains $p.Name){'是'}else{'否'}
        $lines.Add("| $($p.Name) | $required | $kind |")
    }
    $lines.Add('')
}
foreach($t in $tools){
    $lines.Add("## $($t.name)");$lines.Add('');$lines.Add($t.description);$lines.Add('');Add-Fields $t.inputSchema
}
$lines.Add('## action 类型');$lines.Add('')
$actions=($tools|Where-Object name -eq 'execute_batch').inputSchema.properties.actions.items.oneOf
foreach($a in $actions){$lines.Add("### $($a.properties.type.const)");$lines.Add('');Add-Fields $a}
$lines.Add('point/from/to 均为 {x:整数,y:整数}，遵循最近观察的 coordinateSpace：有截图使用图片像素，仅 controls 使用窗口物理像素；程序自动转换，必须在观察范围内。click 的 point/control_id 必须二选一。count 为 1 或 2，actions 数量为 1..256。move.points 为 1..4096 个 [x,y] 整数对；hold 可选 left/right/middle，指定时至少两点：首点按下、连续移动、末点松开，省略则只移动。delay_ms 是动作前等待。完整机器可读定义见 agent-tools.schema.json；该文件由同一命令生成。')
$doc=($lines -join "`n")+"`n"
$schema=$raw.Replace("`r`n","`n").TrimEnd()+"`n"
$outputs=@{'docs/AGENT-API.md'=$doc;'docs/agent-tools.schema.json'=$schema}
foreach($name in $outputs.Keys){
    $path=Join-Path $root $name
    if($Check){if(-not (Test-Path -LiteralPath $path) -or ([IO.File]::ReadAllText($path).Replace("`r`n","`n")) -cne $outputs[$name]){throw "Generated reference is stale: $name"}}
    else{[IO.File]::WriteAllText($path,$outputs[$name],[Text.UTF8Encoding]::new($false))}
}
Write-Output 'Agent schema/reference consistent.'
