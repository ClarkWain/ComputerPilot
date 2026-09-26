$ErrorActionPreference = 'Stop'
$log = 'e:\My_Project\DesktopPilot\tmp_desktop_debug.txt'
$errorlog = 'e:\My_Project\DesktopPilot\tmp_desktop_error.txt'
Set-Content -Path $log -Value 'start'
Set-Content -Path $errorlog -Value ''

try {
  $exe = 'e:\My_Project\DesktopPilot\build\core\Release\desktop-pilot.exe'
  . 'e:\My_Project\DesktopPilot\examples\onboarding\client.ps1'
  $ase = 'C:\Program Files\Aseprite\aseprite.exe'

  $proc = Get-Process aseprite -ErrorAction SilentlyContinue
  if (-not $proc) {
    Start-Process $ase
    Start-Sleep -Seconds 3
    'aseprite started' | Add-Content $log
  } else {
    'aseprite already running' | Add-Content $log
  }

  $client = Open-Pilot $exe
  'client opened' | Add-Content $log

  $list = Call-Pilot $client 'list_windows' @{}
  $list | ConvertTo-Json -Depth 20 | Add-Content $log

  $windows = @($list.windows)
  "count=$($windows.Count)" | Add-Content $log

  if ($windows.Count -gt 0) {
    $aseWin = $windows | Where-Object { $_.title -match 'Aseprite' -or $_.title -match 'aseprite' } | Select-Object -First 1
    if ($aseWin) {
      "selected=$($aseWin.window_id)" | Add-Content $log
      $state = Call-Pilot $client 'get_window_state' @{ window_id = $aseWin.window_id; mode = 'both' }
      $state | ConvertTo-Json -Depth 30 | Add-Content $log
    } else {
      'no aseprite' | Add-Content $log
    }
  }
}
catch {
  $_ | Out-String | Add-Content $errorlog
  $_.Exception | Format-List * | Out-String | Add-Content $errorlog
}
finally {
  if ($client) {
    try { Close-Pilot $client } catch { $_ | Out-String | Add-Content $errorlog }
  }
  'done' | Add-Content $log
}
