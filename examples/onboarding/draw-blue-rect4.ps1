param([string]$Executable)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(-not $Executable){
    $Executable=@((Join-Path $root 'bin/desktop-pilot.exe'),(Join-Path $root 'build/core/Release/desktop-pilot.exe'))|
        Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
}
if(-not $Executable -or -not (Test-Path -LiteralPath $Executable)){throw 'DesktopPilot executable missing.'}
. (Join-Path $PSScriptRoot 'client.ps1')
$client=$null
try {
    $client=Open-Pilot $Executable
    $preflight=$client.Initialization._meta.'desktopPilot/desktopPreflight'
    if(-not $preflight.ready){throw ($preflight|ConvertTo-Json -Depth 20 -Compress)}
    Write-Host 'Preflight: ready'

    $windows=Call-Pilot $client 'list_windows' @{}
    $paintWindow=$null
    foreach($w in $windows.windows){
        if($w.title -match '画图|Paint'){$paintWindow=$w;break}
    }
    if(-not $paintWindow){throw 'No MSPaint window found.'}
    $ref=$paintWindow.window_id
    Write-Host "Found MSPaint: $ref | $($paintWindow.title)"

    # Get controls to find the rectangle button and canvas
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    Write-Host "coordinateSpace: $($state.coordinateSpace)"
    Write-Host "size: $($state.size|ConvertTo-Json -Compress)"
    Write-Host "truncated: $($state.truncated)"
    
    # Find the rectangle button (Button role, name 矩形)
    $rectBtn=$null
    $canvasPane=$null
    foreach($c in $state.controls){
        if($c.name -eq '矩形' -and $c.role -eq 'Button' -and -not $rectBtn){
            $rectBtn=$c
        }
        if($c.name -match '画布' -and -not $canvasPane){
            $canvasPane=$c
        }
    }
    
    if($rectBtn){
        Write-Host "Rectangle button: control_id=$($rectBtn.control_id) bounds=$($rectBtn.bounds|ConvertTo-Json -Compress)"
    } else {
        Write-Host 'Rectangle button NOT found'
    }
    if($canvasPane){
        Write-Host "Canvas pane: control_id=$($canvasPane.control_id) bounds=$($canvasPane.bounds|ConvertTo-Json -Compress)"
    } else {
        Write-Host 'Canvas pane NOT found'
    }
    
    # Also list all controls with bounds to understand layout
    Write-Host ''
    Write-Host 'Controls with bounds:'
    foreach($c in $state.controls){
        $b=$c.bounds
        if($b -and $b.width -gt 0){
            Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id) x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"
        }
    }
} finally {
    Close-Pilot $client
}
