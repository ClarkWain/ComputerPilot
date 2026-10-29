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
$p.StandardInput.WriteLine('{"operation":"window.list","args":{}}')
$line1 = $p.StandardOutput.ReadLine()
$paint = ($line1 | ConvertFrom-Json).result.windows | Where-Object { $_.title -like '*画图*' }
$ref = $paint.windowRef
$req = '{"operation":"ui.tree","args":{"windowRef":"' + $ref + '","format":"locator","depth":16,"limit":400,"nodeBudget":3000,"queryTimeoutMs":5000,"metrics":true}}'
$p.StandardInput.WriteLine($req)
$line2 = $p.StandardOutput.ReadLine()
$p.StandardInput.Close()
$p.WaitForExit(3000) | Out-Null
$line2 | Set-Content 'tests\campaign\resp-tree.json' -Encoding UTF8
$tree = $line2 | ConvertFrom-Json
$els = $tree.result.elements
Write-Output ("ref=$ref  elements=" + $els.Count + "  stopReason=" + $tree.result.stopReason + " evidenceComplete=" + $tree.result.evidenceComplete)
Write-Output '--- name=椭圆形 ---'
$els | Where-Object { $_.name -eq '椭圆形' } | Select-Object name, role, offscreen, enabled, @{n='b'; e = { "$($_.bounds.x),$($_.bounds.y) $($_.bounds.width)x$($_.bounds.height)" } } | Format-Table -AutoSize
Write-Output '--- names containing 椭圆 ---'
$els | Where-Object { $_.name -like '*椭圆*' } | Select-Object name, role, offscreen, enabled | Format-Table -AutoSize
Write-Output '--- role=ListItem count by name (shapes) ---'
$els | Where-Object { $_.role -eq 'ListItem' } | Group-Object name | Select-Object Count, Name | Format-Table -AutoSize
