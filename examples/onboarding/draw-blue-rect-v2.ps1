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

    # Step 1: Click the "形状" (Shapes) tab to reveal shape buttons
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    $shapesTab=$null
    foreach($c in $state.controls){
        if($c.name -eq '形状' -and $c.role -eq '50026'){
            $shapesTab=$c
            break
        }
    }
    if(-not $shapesTab){throw 'Shapes tab not found.'}
    Write-Host "Shapes tab: $($shapesTab.control_id)"
    
    $r1=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$shapesTab.control_id;delay_ms=500})}
    Write-Host "Clicked shapes tab: $($r1|ConvertTo-Json -Compress)"
    
    # Step 2: Get new state to find the rectangle button
    $state2=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    $rectBtn=$null
    foreach($c in $state2.controls){
        if($c.name -eq '矩形' -and $c.role -eq 'Button'){
            $rectBtn=$c
            break
        }
    }
    if(-not $rectBtn){
        # List all buttons to debug
        Write-Host 'All buttons after clicking shapes tab:'
        foreach($c in $state2.controls){
            if($c.role -eq 'Button'){
                $b=$c.bounds
                Write-Host "  '$($c.name)' id=$($c.control_id) $(if($b){'x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)'}else{'no bounds'})"
            }
        }
        throw 'Rectangle button still not found after clicking shapes tab.'
    }
    Write-Host "Rectangle button: $($rectBtn.control_id)"
    
    # Step 3: Click the rectangle tool
    $r2=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$rectBtn.control_id;delay_ms=300})}
    Write-Host "Clicked rectangle tool: $($r2|ConvertTo-Json -Compress)"
    
    # Step 4: Draw a rectangle by dragging on the canvas
    # Canvas is below the ribbon. Window is ~1708x960. 
    # Ribbon is about 150px tall. Canvas starts around y=150
    # Draw from (200,250) to (500,450)
    $r3=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='move';points=@(@(200,250),@(500,450));hold='left';delay_ms=300})}
    Write-Host "Drew rectangle: $($r3|ConvertTo-Json -Compress)"
    
    # Step 5: Get screenshot to verify
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'v2-result.png'
    Copy-Item -LiteralPath $after.capture.path -Destination $outFile
    Write-Host "Screenshot: $outFile"
    
    # Pixel verification
    Add-Type -AssemblyName System.Drawing
    $bitmap=[Drawing.Bitmap]::new($outFile)
    $w=$bitmap.Width; $h=$bitmap.Height
    Write-Host "Image: ${w}x${h}"
    # Check the area where we drew
    $nonWhite=0; $blue=0; $total=0
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
    Write-Host "Verification: $nonWhite/$total non-white, $blue blue pixels in (150,200)-(550,500)"
    $bitmap.Dispose()
} finally {
    Close-Pilot $client
}
