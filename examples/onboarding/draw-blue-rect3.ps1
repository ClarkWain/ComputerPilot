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
    if(-not $paintWindow){
        Write-Host 'Available windows:'
        foreach($w in $windows.windows){Write-Host "  $($w.window_id) | $($w.title) | pid=$($w.pid)"}
        throw 'No MSPaint window found.'
    }
    $ref=$paintWindow.window_id
    Write-Host "Found MSPaint: $ref | $($paintWindow.title)"

    # Get screenshot to understand layout
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    Write-Host "coordinateSpace: $($state.coordinateSpace)"
    Write-Host "size: $($state.size|ConvertTo-Json -Compress)"
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'paint-before.png'
    Copy-Item -LiteralPath $state.capture.path -Destination $outFile
    Write-Host "Screenshot saved: $outFile"
    Write-Host "originalPath: $($state.capture.originalPath)"
} finally {
    Close-Pilot $client
}
