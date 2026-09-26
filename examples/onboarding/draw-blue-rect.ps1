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
        if($w.title -match '画图|Paint|无标题'){
            $paintWindow=$w
            break
        }
    }
    if(-not $paintWindow){
        # Fallback: look for MSPaintApp or mspaint.exe
        foreach($w in $windows.windows){
            if($w.title -match 'mspaint|MSPaint'){
                $paintWindow=$w
                break
            }
        }
    }
    if(-not $paintWindow){
        Write-Host 'Available windows:'
        foreach($w in $windows.windows){Write-Host "  $($w.window_id) | $($w.title) | pid=$($w.pid)"}
        throw 'No MSPaint window found.'
    }
    $ref=$paintWindow.window_id
    Write-Host "Found MSPaint: $ref | $($paintWindow.title)"

    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    Write-Host "Semantic status: $($state.semantic.status)"
    $profiles=@($state.semantic.profiles | ForEach-Object { $_.id })
    Write-Host "Profiles: $($profiles -join ', ')"
    if($state.truncated){Write-Warning 'Window state truncated; proceeding anyway.'}

    # Draw a blue rectangle using the mspaint-classic-zh-CN profile
    $action=@{
        action='drawing.drawRectangle'
        args=@{
            position=@(30,40)
            size=@(120,80)
            stroke=@{color=@(0,0,255);width=2}
            fill=@(0,0,255)
        }
    }
    $result=Call-Pilot $client 'execute_semantic' @{window_id=$ref;profile='mspaint-classic-zh-CN';actions=@($action)}
    Write-Host "Semantic result: $($result|ConvertTo-Json -Depth 10 -Compress)"

    # Capture screenshot for verification
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    Write-Host "Screenshot: $($after.capture.path)"
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'blue-rect.png'
    Copy-Item -LiteralPath $after.capture.path -Destination $outFile
    Write-Host "Saved: $outFile"
} finally {
    Close-Pilot $client
}
