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

    # Step 1: Observe first (required before any batch)
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    Write-Host "Initial size: $($state.size|ConvertTo-Json -Compress)"
    
    # Step 2: Maximize using Win+Up
    $r0=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='press_keys';chord='Win+Up';delay_ms=500})}
    Write-Host "Maximized: $($r0|ConvertTo-Json -Compress)"
    
    # Step 3: Re-observe after maximize
    $state2=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    Write-Host "After maximize size: $($state2.size|ConvertTo-Json -Compress)"
    Write-Host "semantic.status: $($state2.semantic.status)"
    if($state2.semantic.profiles){
        foreach($p in $state2.semantic.profiles){
            Write-Host "Profile: $($p.id)"
        }
    }
    if($state2.semantic.unavailable){
        foreach($u in $state2.semantic.unavailable){
            Write-Host "Unmatched: $($u.id)"
            foreach($r in $u.reasons){Write-Host "  reason: $r"}
        }
    }
    
    # Step 4: Find and click the shapes tab
    $shapesTab=$null
    foreach($c in $state2.controls){
        if($c.name -eq '形状'){$shapesTab=$c;break}
    }
    if($shapesTab){
        $r1=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$shapesTab.control_id;delay_ms=500})}
        Write-Host "Clicked shapes tab: $($r1|ConvertTo-Json -Compress)"
        
        # Step 5: Re-observe
        $state3=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
        
        # Find rectangle button
        $rectBtn=$null
        foreach($c in $state3.controls){
            if($c.name -eq '矩形' -and $c.role -eq 'Button'){
                $rectBtn=$c
                break
            }
        }
        
        if($rectBtn){
            # Step 6: Click rectangle tool
            $r2=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$rectBtn.control_id;delay_ms=300})}
            Write-Host "Clicked rectangle: $($r2|ConvertTo-Json -Compress)"
            
            # Step 7: Re-observe
            $state4=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
            
            # Step 8: Draw rectangle
            $r3=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='move';points=@(@(200,250),@(500,450));hold='left';delay_ms=300})}
            Write-Host "Drew: $($r3|ConvertTo-Json -Compress)"
        } else {
            # Try alternative
            $rectAlt=$null
            foreach($c in $state3.controls){
                if($c.name -match '矩形'){$rectAlt=$c;break}
            }
            if($rectAlt){
                $r2=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$rectAlt.control_id;delay_ms=300})}
                Write-Host "Clicked rect alt: $($r2|ConvertTo-Json -Compress)"
                $state4=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
                $r3=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='move';points=@(@(200,250),@(500,450));hold='left';delay_ms=300})}
                Write-Host "Drew: $($r3|ConvertTo-Json -Compress)"
            } else {
                Write-Host 'Rectangle tool not found, drawing with current tool'
                $r3=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='move';points=@(@(200,250),@(500,450));hold='left';delay_ms=300})}
                Write-Host "Drew: $($r3|ConvertTo-Json -Compress)"
            }
        }
    }
    
    # Step 9: Get screenshot
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'max2-result.png'
    Copy-Item -LiteralPath $after.capture.path -Destination $outFile
    Write-Host "Screenshot: $outFile"
    
    # Pixel verification
    Add-Type -AssemblyName System.Drawing
    $bitmap=[Drawing.Bitmap]::new($outFile)
    $w=$bitmap.Width; $h=$bitmap.Height
    Write-Host "Image: ${w}x${h}"
    $nonWhite=0; $total=0; $blue=0
    for($y=100;$y -lt [Math]::Min(600,$h);$y+=10){
        for($x=100;$x -lt [Math]::Min(600,$w);$x+=10){
            $px=$bitmap.GetPixel($x,$y)
            if($px.R -ne 255 -or $px.G -ne 255 -or $px.B -ne 255){
                $nonWhite++
                if($px.B -gt 150 -and $px.R -lt 100 -and $px.G -lt 100){$blue++}
            }
            $total++
        }
    }
    Write-Host "Verification: $nonWhite/$total non-white, $blue blue pixels in (100,100)-(600,600)"
    $bitmap.Dispose()
} finally {
    Close-Pilot $client
}
