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

    # Get controls and find the rectangle tool
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    
    # Look for the rectangle tool in any form
    $rectControl=$null
    foreach($c in $state.controls){
        if($c.name -match '矩形' -and $c.role -ne 'Window'){
            $rectControl=$c
            Write-Host "Found: [$($c.role)] '$($c.name)' id=$($c.control_id)"
        }
    }
    
    if($rectControl){
        # Click the rectangle tool
        $r1=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$rectControl.control_id;delay_ms=300})}
        Write-Host "Clicked rectangle tool: $($r1|ConvertTo-Json -Compress)"
    } else {
        # Try clicking the shapes tab first
        $shapesTab=$null
        foreach($c in $state.controls){
            if($c.name -eq '形状'){$shapesTab=$c;break}
        }
        if($shapesTab){
            $r0=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$shapesTab.control_id;delay_ms=500})}
            Write-Host "Clicked shapes tab: $($r0|ConvertTo-Json -Compress)"
            # Re-scan
            $state2=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
            foreach($c in $state2.controls){
                if($c.name -match '矩形' -and $c.role -ne 'Window'){
                    $rectControl=$c
                    Write-Host "Found after tab click: [$($c.role)] '$($c.name)' id=$($c.control_id)"
                    break
                }
            }
            if($rectControl){
                $r1=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$rectControl.control_id;delay_ms=300})}
                Write-Host "Clicked rectangle tool: $($r1|ConvertTo-Json -Compress)"
            }
        }
    }
    
    if(-not $rectControl){
        # Last resort: use keyboard shortcut or just draw with whatever tool is active
        Write-Host 'WARNING: Rectangle tool not found, drawing with current tool'
    }
    
    # Draw a rectangle by dragging on the canvas
    # Window is ~1708x960. Canvas starts below ribbon (~150px)
    # Draw from (200,250) to (500,450)
    $r2=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='move';points=@(@(200,250),@(500,450));hold='left';delay_ms=300})}
    Write-Host "Drew shape: $($r2|ConvertTo-Json -Compress)"
    
    # Get screenshot to verify
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'v3-result.png'
    Copy-Item -LiteralPath $after.capture.path -Destination $outFile
    Write-Host "Screenshot: $outFile"
    
    # Pixel verification - check if there are colored pixels in the canvas area
    Add-Type -AssemblyName System.Drawing
    $bitmap=[Drawing.Bitmap]::new($outFile)
    $w=$bitmap.Width; $h=$bitmap.Height
    Write-Host "Image: ${w}x${h}"
    $nonWhite=0; $total=0
    $coloredPixels=@()
    for($y=200;$y -lt 500;$y+=10){
        for($x=150;$x -lt 550;$x+=10){
            if($x -ge $w -or $y -ge $h){continue}
            $total++
            $px=$bitmap.GetPixel($x,$y)
            if($px.R -ne 255 -or $px.G -ne 255 -or $px.B -ne 255){
                $nonWhite++
                if($coloredPixels.Count -lt 5){$coloredPixels+= "($x,$y) R=$($px.R) G=$($px.G) B=$($px.B)"}
            }
        }
    }
    Write-Host "Verification: $nonWhite/$total non-white pixels in canvas area"
    if($coloredPixels.Count -gt 0){
        Write-Host "Sample pixels:"
        foreach($p in $coloredPixels){Write-Host "  $p"}
    }
    $bitmap.Dispose()
} finally {
    Close-Pilot $client
}
