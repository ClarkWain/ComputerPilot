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

    $windows=Call-Pilot $client 'list_windows' @{}
    $paintWindow=$null
    foreach($w in $windows.windows){
        if($w.title -match '画图|Paint'){$paintWindow=$w;break}
    }
    if(-not $paintWindow){throw 'No MSPaint window found.'}
    $ref=$paintWindow.window_id
    Write-Host "Found MSPaint: $ref | $($paintWindow.title)"

    # Get full controls state
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    
    # Find all ListItem controls (shapes) and their positions
    Write-Host 'Shape ListItems:'
    foreach($c in $state.controls){
        if($c.role -eq 'ListItem' -and $c.name){
            $b=$c.bounds
            if($b){Write-Host "  '$($c.name)' x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
        }
    }
    
    # Find all controls with y > 100 (below the ribbon)
    Write-Host ''
    Write-Host 'Controls below y=100:'
    foreach($c in $state.controls){
        $b=$c.bounds
        if($b -and $b.y -gt 100){
            Write-Host "  [$($c.role)] '$($c.name)' x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"
        }
    }
    
    # Get a screenshot with region for the canvas area (bottom half)
    $img=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image';region=@{x=0;y=100;width=1366;height=668}}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'canvas-area.png'
    Copy-Item -LiteralPath $img.capture.path -Destination $outFile
    Write-Host "Canvas area screenshot: $outFile"
    Write-Host "coordinateSpace: $($img.coordinateSpace)"
} finally {
    Close-Pilot $client
}
