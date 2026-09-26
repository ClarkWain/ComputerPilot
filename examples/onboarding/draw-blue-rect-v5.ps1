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
    
    # Find color-related controls
    $colorControls=@()
    foreach($c in $state.controls){
        if($c.name -match '颜色|Color' -or $c.role -match 'Button' -and $c.name -match '编辑'){
            $colorControls+= $c
            Write-Host "Color-related: [$($c.role)] '$($c.name)' id=$($c.control_id)"
        }
    }
    
    # Find the "颜色" tab
    $colorTab=$null
    foreach($c in $state.controls){
        if($c.name -eq '颜色'){$colorTab=$c;break}
    }
    if($colorTab){
        Write-Host "Color tab found: $($colorTab.control_id)"
        # Click the color tab
        $r0=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$colorTab.control_id;delay_ms=500})}
        Write-Host "Clicked color tab: $($r0|ConvertTo-Json -Compress)"
        
        # Re-observe to find color buttons
        $state2=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
        Write-Host "Controls after color tab: $($state2.controls.Count)"
        foreach($c in $state2.controls){
            if($c.name -match '颜色|编辑|Color|RGB|红|绿|蓝' -and $c.role -ne 'Window'){
                Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id)"
            }
        }
    }
    
    # Step 2: Find and click the rectangle tool
    $rectControl=$null
    foreach($c in $state.controls){
        if($c.name -match '矩形' -and $c.role -ne 'Window'){
            $rectControl=$c
            break
        }
    }
    if($rectControl){
        $r1=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$rectControl.control_id;delay_ms=300})}
        Write-Host "Clicked rectangle tool: $($r1|ConvertTo-Json -Compress)"
        # Re-observe
        $state3=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
        Write-Host "Re-observed: $($state3.controls.Count) controls"
    }
    
    # Step 3: Draw a rectangle
    $r2=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='move';points=@(@(200,250),@(500,450));hold='left';delay_ms=300})}
    Write-Host "Drew shape: $($r2|ConvertTo-Json -Compress)"
    
    # Step 4: Get screenshot
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'v5-result.png'
    Copy-Item -LiteralPath $after.capture.path -Destination $outFile
    Write-Host "Screenshot: $outFile"
    
    # Pixel verification
    Add-Type -AssemblyName System.Drawing
    $bitmap=[Drawing.Bitmap]::new($outFile)
    $w=$bitmap.Width; $h=$bitmap.Height
    $nonWhite=0; $total=0; $blue=0
    for($y=200;$y -lt 500;$y+=10){
        for($x=150;$x -lt 550;$x+=10){
            if($x -ge $w -or $y -ge $h){continue}
            $total++
            $px=$bitmap.GetPixel($x,$y)
            if($px.R -ne 255 -or $px.G -ne 255 -or $px.B -ne 255){
                $nonWhite++
                if($px.B -gt 150 -and $px.R -lt 100 -and $px.G -lt 100){$blue++}
            }
        }
    }
    Write-Host "Verification: $nonWhite/$total non-white, $blue blue pixels"
    $bitmap.Dispose()
} finally {
    Close-Pilot $client
}
