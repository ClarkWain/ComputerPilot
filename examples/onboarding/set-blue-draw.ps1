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

    # Step 1: Observe
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    Write-Host "Size: $($state.size|ConvertTo-Json -Compress)"
    
    # List all controls to find color-related ones
    Write-Host 'All controls:'
    foreach($c in $state.controls){
        $b=$c.bounds
        $bStr=''
        if($b -and $b.width -gt 0){$bStr=" x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
        Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id)$bStr"
    }
    
    # Step 2: Click the "颜色" (Color) tab
    $colorTab=$null
    foreach($c in $state.controls){
        if($c.name -eq '颜色'){$colorTab=$c;break}
    }
    if($colorTab){
        $r1=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$colorTab.control_id;delay_ms=500})}
        Write-Host "Clicked color tab: $($r1|ConvertTo-Json -Compress)"
        
        # Step 3: Re-observe to see color controls
        $state2=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
        Write-Host 'Controls after color tab:'
        foreach($c in $state2.controls){
            $b=$c.bounds
            $bStr=''
            if($b -and $b.width -gt 0){$bStr=" x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
            Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id)$bStr"
        }
    }
} finally {
    Close-Pilot $client
}
