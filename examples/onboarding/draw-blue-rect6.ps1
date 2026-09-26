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

    # First, get controls to find the rectangle button
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    $rectBtn=$null
    foreach($c in $state.controls){
        if($c.name -eq '矩形' -and $c.role -eq 'Button'){
            $rectBtn=$c
            break
        }
    }
    if(-not $rectBtn){throw 'Rectangle button not found.'}
    $rb=$rectBtn.bounds
    $rectX=[int][Math]::Floor($rb.x + $rb.width/2)
    $rectY=[int][Math]::Floor($rb.y + $rb.height/2)
    Write-Host "Rectangle button center: ($rectX, $rectY)"

    # Canvas area: below the ribbon (y~100) to bottom, left side
    # Window is 1366x768. Canvas starts around y=100, x=0
    # Draw a rectangle from (100,200) to (300,400) in window coordinates
    $canvasStart=@(100,200)
    $canvasEnd=@(300,400)
    
    # Step 1: Click the rectangle tool button
    # Step 2: Drag on canvas to draw the rectangle
    $actions=@(
        @{type='click';control_id=$rectBtn.control_id;delay_ms=100},
        @{type='move';points=@($canvasStart,$canvasEnd);hold='left';delay_ms=200}
    )
    
    Write-Host "Drawing rectangle from ($($canvasStart[0]),$($canvasStart[1])) to ($($canvasEnd[0]),$($canvasEnd[1]))"
    $result=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=$actions}
    Write-Host "Batch result: $($result|ConvertTo-Json -Depth 10 -Compress)"

    # Get screenshot to verify
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'blue-rect-result.png'
    Copy-Item -LiteralPath $after.capture.path -Destination $outFile
    Write-Host "Result screenshot: $outFile"
} finally {
    Close-Pilot $client
}
