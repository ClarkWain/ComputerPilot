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
    
    # Step 2: Click "颜色" tab
    $colorTab=$null
    foreach($c in $state.controls){
        if($c.name -eq '颜色'){$colorTab=$c;break}
    }
    if($colorTab){
        $r1=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$colorTab.control_id;delay_ms=500})}
        Write-Host "Clicked color tab: $($r1|ConvertTo-Json -Compress)"
        
        # Step 3: Re-observe
        $state2=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
        
        # Look for any control with "颜色" or "Color" in name
        Write-Host 'Color-related controls:'
        foreach($c in $state2.controls){
            if($c.name -match '颜色|Color|RGB|红|绿|蓝' -and $c.role -ne 'Window'){
                $b=$c.bounds
                $bStr=''
                if($b -and $b.width -gt 0){$bStr=" x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
                Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id)$bStr"
            }
        }
        
        # Look for buttons
        Write-Host 'All buttons:'
        foreach($c in $state2.controls){
            if($c.role -eq 'Button'){
                $b=$c.bounds
                $bStr=''
                if($b -and $b.width -gt 0){$bStr=" x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
                Write-Host "  '$($c.name)' id=$($c.control_id)$bStr"
            }
        }
        
        # Try to find and click a color button
        $colorBtn=$null
        foreach($c in $state2.controls){
            if($c.role -eq 'Button' -and $c.name -match '颜色|Color'){
                $colorBtn=$c
                break
            }
        }
        
        if($colorBtn){
            $r2=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$colorBtn.control_id;delay_ms=500})}
            Write-Host "Clicked color button: $($r2|ConvertTo-Json -Compress)"
            
            # Check for new dialog
            Start-Sleep -Seconds 1
            $windows2=Call-Pilot $client 'list_windows' @{}
            Write-Host 'All windows:'
            foreach($w in $windows2.windows){
                Write-Host "  $($w.window_id) | $($w.title) | pid=$($w.pid)"
            }
        }
    }
} finally {
    Close-Pilot $client
}
