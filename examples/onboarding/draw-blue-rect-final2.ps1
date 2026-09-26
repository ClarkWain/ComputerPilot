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

    # Get full state with both controls and image
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='both'}
    Write-Host "coordinateSpace: $($state.coordinateSpace)"
    Write-Host "size: $($state.size|ConvertTo-Json -Compress)"
    Write-Host "truncated: $($state.truncated)"
    Write-Host "semantic.status: $($state.semantic.status)"
    
    # Check if any profiles match
    if($state.semantic.profiles){
        foreach($p in $state.semantic.profiles){
            Write-Host "Profile: $($p.id)"
        }
    }
    if($state.semantic.unavailable){
        foreach($u in $state.semantic.unavailable){
            Write-Host "Unmatched: $($u.id)"
            foreach($r in $u.reasons){Write-Host "  reason: $r"}
        }
    }
    
    # List all controls with bounds
    Write-Host ''
    Write-Host 'All controls:'
    foreach($c in $state.controls){
        $b=$c.bounds
        $bStr=''
        if($b -and $b.width -gt 0){$bStr=" x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
        Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id)$bStr"
    }
    
    # Save screenshot
    if($state.capture){
        $outDir=Join-Path $root 'out/blue-rect'
        [void][IO.Directory]::CreateDirectory($outDir)
        $outFile=Join-Path $outDir 'fresh-state.png'
        Copy-Item -LiteralPath $state.capture.path -Destination $outFile
        Write-Host "Screenshot: $outFile"
    }
} finally {
    Close-Pilot $client
}
