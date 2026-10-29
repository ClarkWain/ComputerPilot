$ErrorActionPreference = 'Stop'
Set-Location 'g:\Workspace\ComputerPilot'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = '.\build\core\Release\computer-pilot.exe'; $psi.Arguments = 'jsonl'
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$p = [System.Diagnostics.Process]::Start($psi)
function Send($op, $a, [int]$timeoutMs = 600000) {
  $p.StandardInput.WriteLine((@{operation = $op; args = $a } | ConvertTo-Json -Compress -Depth 20))
  return $p.StandardOutput.ReadLine() | ConvertFrom-Json
}
$list = Send 'window.list' @{}
$paint = $list.result.windows | Where-Object { $_.title -like '*画图*' } | Select-Object -First 1
$ref = $paint.windowRef
Write-Output ("Paint ref=$ref title='" + $paint.title + "'")
# Clear any stuck ribbon flyout from a prior attempt.
Send 'window.activate' @{windowRef = $ref } | Out-Null
Send 'input.key_chord' @{windowRef = $ref; keys = @('Escape') } | Out-Null
Send 'input.key_chord' @{windowRef = $ref; keys = @('Escape') } | Out-Null

# colors
$red = @(222, 28, 33); $dark = @(45, 36, 30); $yellow = @(247, 182, 10); $yolk = @(150, 95, 20); $stem = @(70, 50, 40); $green = @(30, 150, 74)
$C = @(470, 290)
function P($x, $y) { return , @([int][math]::Round($x), [int][math]::Round($y)) }

$actions = New-Object System.Collections.ArrayList

# 1) stem first (covered by flower head) - drawLine segments so the width menu (line tool) matches
$sp = @((P 462 355), (P 435 448), (P 392 548), (P 345 648), (P 302 735))
for ($s = 0; $s -lt $sp.Count - 1; $s++) {
  $a = @{from = $sp[$s]; to = $sp[$s + 1] }
  if ($s -eq 0) { $a.stroke = @{color = $stem; width = 5 } }
  [void]$actions.Add(@{action = 'drawing.drawLine'; args = $a })
}

# 2) 16 petals (first sets style, rest reuse)
$N = 16; $ri = 60; $r2 = 100; $rm = 135; $ro = 185; $w = 28; $w2 = 17
for ($i = 0; $i -lt $N; $i++) {
  $th = (-90 + $i * (360.0 / $N)) * [math]::PI / 180.0
  $ux = [math]::Cos($th); $uy = [math]::Sin($th); $px = - $uy; $py = $ux
  $pts = @(
    (P ($C[0] + $ri * $ux) ($C[1] + $ri * $uy)),
    (P ($C[0] + $r2 * $ux + $w2 * $px) ($C[1] + $r2 * $uy + $w2 * $py)),
    (P ($C[0] + $rm * $ux + $w * $px) ($C[1] + $rm * $uy + $w * $py)),
    (P ($C[0] + $ro * $ux) ($C[1] + $ro * $uy)),
    (P ($C[0] + $rm * $ux - $w * $px) ($C[1] + $rm * $uy - $w * $py)),
    (P ($C[0] + $r2 * $ux - $w2 * $px) ($C[1] + $r2 * $uy - $w2 * $py))
  )
  $a = @{points = $pts }
  if ($i -eq 0) { $a.fill = $red; $a.stroke = @{color = $dark; width = 3 } }
  [void]$actions.Add(@{action = 'drawing.drawPolygon'; args = $a })
}

# 3) yellow center on top of petal bases + stem top
[void]$actions.Add(@{action = 'drawing.drawCircle'; args = @{center = $C; radius = 80; fill = $yellow; stroke = @{color = $yolk; width = 1 } } })

# 4) leaves (green) + midribs
$leaf = {
  param($bx, $by, $tx, $ty, $lw)
  $ax = $tx - $bx; $ay = $ty - $by; $L = [math]::Sqrt($ax * $ax + $ay * $ay); $ux = $ax / $L; $uy = $ay / $L; $px = - $uy; $py = $ux
  return @(
    (P $bx $by),
    (P ($bx + 0.30 * $ax + 0.7 * $lw * $px) ($by + 0.30 * $ay + 0.7 * $lw * $py)),
    (P ($bx + 0.55 * $ax + $lw * $px) ($by + 0.55 * $ay + $lw * $py)),
    (P $tx $ty),
    (P ($bx + 0.55 * $ax - $lw * $px) ($by + 0.55 * $ay - $lw * $py)),
    (P ($bx + 0.30 * $ax - 0.7 * $lw * $px) ($by + 0.30 * $ay - 0.7 * $lw * $py))
  )
}
$leaf1 = & $leaf 415 500 255 425 40
$leaf2 = & $leaf 365 630 510 612 36
[void]$actions.Add(@{action = 'drawing.drawPolygon'; args = @{points = $leaf1; fill = $green; stroke = @{color = $dark; width = 3 } } })
[void]$actions.Add(@{action = 'drawing.drawPolygon'; args = @{points = $leaf2 } })
[void]$actions.Add(@{action = 'drawing.drawLine'; args = @{from = (P 415 500); to = (P 262 432); stroke = @{color = $dark; width = 1 } } })
[void]$actions.Add(@{action = 'drawing.drawLine'; args = @{from = (P 365 630); to = (P 500 613) } })

Write-Output ("total actions = " + $actions.Count)
$res = Send 'semantic.execute' @{windowRef = $ref; actions = $actions; providerTimeoutMs = 600000 }
$res | ConvertTo-Json -Depth 8 -Compress | Out-File 'g:\Workspace\ComputerPilot\tests\campaign\flower-result.json' -Encoding UTF8
Write-Output ('status=' + $res.result.status + ' completed=' + $res.result.completed + '/' + $res.result.total + ' failedIndex=' + $res.result.failedIndex + ' phase=' + $res.result.failure.phase + ' msg=' + $res.result.failure.message + ' err=' + $res.error.message)
$p.StandardInput.Close(); $p.WaitForExit(5000) | Out-Null
