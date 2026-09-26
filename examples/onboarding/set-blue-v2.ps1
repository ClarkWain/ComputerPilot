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
        
        # Look for "编辑颜色" button
        $editColors=$null
        foreach($c in $state2.controls){
            if($c.name -match '编辑颜色|Edit Color' -and $c.role -eq 'Button'){
                $editColors=$c
                Write-Host "Found edit colors: $($editColors.control_id)"
                break
            }
        }
        
        # Also look for any button with "颜色" in name
        if(-not $editColors){
            foreach($c in $state2.controls){
                if($c.role -eq 'Button' -and $c.name -match '颜色'){
                    Write-Host "Color button: '$($c.name)' id=$($c.control_id)"
                }
            }
        }
        
        if($editColors){
            # Step 4: Click edit colors
            $r2=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$editColors.control_id;delay_ms=500})}
            Write-Host "Clicked edit colors: $($r2|ConvertTo-Json -Compress)"
            
            # Step 5: Check for new dialog window
            Start-Sleep -Seconds 1
            $windows2=Call-Pilot $client 'list_windows' @{}
            Write-Host 'All windows:'
            foreach($w in $windows2.windows){
                Write-Host "  $($w.window_id) | $($w.title) | pid=$($w.pid)"
            }
            
            # Look for a color dialog
            $colorDialog=$null
            foreach($w in $windows2.windows){
                if($w.title -match '编辑颜色|Color|颜色'){
                    $colorDialog=$w
                    break
                }
            }
            
            if($colorDialog){
                Write-Host "Found color dialog: $($colorDialog.window_id) | $($colorDialog.title)"
                # Get its controls
                $dlgState=Call-Pilot $client 'get_window_state' @{window_id=$colorDialog.window_id;mode='controls'}
                Write-Host 'Dialog controls:'
                foreach($c in $dlgState.controls){
                    Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id)"
                }
            }
        }
    }
} finally {
    Close-Pilot $client
}
