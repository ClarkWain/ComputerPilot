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
        if($w.title -match '画图|Paint'){
            $paintWindow=$w
            break
        }
    }
    if(-not $paintWindow){
        Write-Host 'Available windows:'
        foreach($w in $windows.windows){Write-Host "  $($w.window_id) | $($w.title) | pid=$($w.pid)"}
        throw 'No MSPaint window found.'
    }
    $ref=$paintWindow.window_id
    Write-Host "Found MSPaint: $ref | $($paintWindow.title)"

    # First, inspect the window state to understand the control layout
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    Write-Host "Semantic status: $($state.semantic.status)"
    if($state.semantic.unavailable){
        foreach($u in $state.semantic.unavailable){
            Write-Host "Unmatched profile: $($u.id)"
            foreach($r in $u.reasons){Write-Host "  reason: $r"}
            if($u.recommendedWindow){
                Write-Host "  recommended: $($u.recommendedWindow|ConvertTo-Json -Compress)"
            }
        }
    }
    # Dump all control names to find duplicates
    $names=@{}
    foreach($c in $state.controls){
        if($c.name){
            if(-not $names.ContainsKey($c.name)){$names[$c.name]=0}
            $names[$c.name]++
        }
    }
    Write-Host 'Control names with counts (top 40):'
    $names.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 40 | ForEach-Object {
        Write-Host "  $($_.Key) => $($_.Value)"
    }
} finally {
    Close-Pilot $client
}
