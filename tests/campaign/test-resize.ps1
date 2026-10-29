$ErrorActionPreference = 'Stop'
Set-Location 'g:\Workspace\ComputerPilot'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = '.\build\core\Release\computer-pilot.exe'
$psi.Arguments = 'jsonl'
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$p = [System.Diagnostics.Process]::Start($psi)
function Send($op, $arguments) {
  $msg = @{ operation = $op; args = $arguments } | ConvertTo-Json -Compress -Depth 10
  $p.StandardInput.WriteLine($msg)
  return $p.StandardOutput.ReadLine() | ConvertFrom-Json
}
$list = Send 'window.list' @{}
$paint = $list.result.windows | Where-Object { $_.title -like '*画图*' }
$ref = $paint.windowRef
Write-Output ("Paint ref=$ref  orig " + $paint.bounds.width + 'x' + $paint.bounds.height + ' dpi=' + $paint.dpi)
# Try resize wide (physical px)
$rz = Send 'window.resize' @{ windowRef = $ref; width = 1920; height = 1200 }
Write-Output ('resize status=' + $rz.result.status + ' ' + $rz.error.message)
Start-Sleep -Milliseconds 600
$tree = Send 'ui.tree' @{ windowRef = $ref; format = 'locator'; depth = 16; limit = 400; nodeBudget = 3000; queryTimeoutMs = 5000 }
$els = $tree.result.elements
Write-Output ('elements=' + $els.Count + ' stop=' + $tree.result.stopReason)
$ell = $els | Where-Object { $_.name -eq '椭圆形' }
Write-Output ('椭圆形 count=' + ($ell | Measure-Object).Count)
$ell | Select-Object name, role, offscreen, enabled | Format-Table -AutoSize
$li = $els | Where-Object { $_.role -eq 'ListItem' }
Write-Output ('ListItem count=' + ($li | Measure-Object).Count + '  names: ' + (($li | ForEach-Object { $_.name }) -join ' | '))
$p.StandardInput.Close(); $p.WaitForExit(3000) | Out-Null
