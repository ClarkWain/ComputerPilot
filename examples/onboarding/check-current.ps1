param([string]$Executable)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(-not $Executable){
    $Executable=@((Join-Path $root 'bin/desktop-pilot.exe'),(Join-Path $root 'build/core/Release/desktop-pilot.exe'))|
        Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
}
. (Join-Path $PSScriptRoot 'client.ps1')
$client=$null
try {
    $client=Open-Pilot $Executable
    $preflight=$client.Initialization._meta.'desktopPilot/desktopPreflight'
    if(-not $preflight.ready){throw ($preflight|ConvertTo-Json -Depth 20 -Compress)}
    
    $windows=Call-Pilot $client 'list_windows' @{}
    $paintWindow=$null
    foreach($w in $windows.windows){
        if($w.title -match '画图|Paint'){$paintWindow=$w;break}
    }
    if(-not $paintWindow){throw 'No MSPaint window found.'}
    $ref=$paintWindow.window_id
    Write-Host "Window: $ref | $($paintWindow.title)"
    
    # Get screenshot
    $img=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'current-state.png'
    Copy-Item -LiteralPath $img.capture.path -Destination $outFile
    Write-Host "Screenshot: $outFile"
    Write-Host "coordinateSpace: $($img.coordinateSpace)"
    Write-Host "size: $($img.size|ConvertTo-Json -Compress)"
    
    # Also get controls
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    Write-Host "Controls: $($state.controls.Count) (truncated: $($state.truncated))"
    # Show all controls with bounds
    foreach($c in $state.controls){
        $b=$c.bounds
        $bStr=''
        if($b -and $b.width -gt 0){$bStr=" x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
        Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id)$bStr"
    }
} finally {
    Close-Pilot $client
}
