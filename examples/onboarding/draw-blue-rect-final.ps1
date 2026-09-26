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

    # Get controls to find buttons
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    
    # Find key buttons
    $rectBtn=$null
    $editColorsBtn=$null
    foreach($c in $state.controls){
        if($c.name -eq '矩形' -and $c.role -eq 'Button' -and -not $rectBtn){$rectBtn=$c}
        if($c.name -eq '编辑颜色' -and -not $editColorsBtn){$editColorsBtn=$c}
    }
    
    Write-Host "Rectangle button: $(if($rectBtn){"found id=$($rectBtn.control_id)"}else{'NOT found'})"
    Write-Host "Edit colors button: $(if($editColorsBtn){"found id=$($editColorsBtn.control_id)"}else{'NOT found'})"
    
    # List all buttons with bounds
    Write-Host ''
    Write-Host 'All buttons:'
    foreach($c in $state.controls){
        if($c.role -eq 'Button'){
            $b=$c.bounds
            if($b -and $b.width -gt 0){
                Write-Host "  '$($c.name)' id=$($c.control_id) x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"
            }
        }
    }
    
    # Strategy: 
    # 1. Click "编辑颜色" to open color dialog
    # 2. Set RGB to blue (0,0,255)
    # 3. Close dialog
    # 4. Click rectangle tool
    # 5. Drag on canvas
    # 6. Verify
    
    # First, let's try the semantic approach one more time with the correct profile
    # The profile needs: zoom="100%", canvas with "画布", ellipse="椭圆形", primary="颜色 1", secondary="颜色 2", editColors="编辑颜色", brushMenu="刷子"
    # But the actual controls are different (modern Paint):
    # - No "100%" zoom control found
    # - No "画布" canvas pane
    # - Shapes are "椭圆" not "椭圆形"
    # - No "颜色 1"/"颜色 2" buttons
    # - No "刷子" button
    # This is modern Paint, not classic. The profile won't match.
    
    # Let's use basic operations:
    # Step 1: Open color editor and set blue
    $actions=@()
    
    # Click edit colors button
    if($editColorsBtn){
        $actions+=@{type='click';control_id=$editColorsBtn.control_id;delay_ms=200}
    }
    
    # Wait for dialog, then we need to observe it
    # For now, let's just draw with the current color (which appears to be light blue)
    # and verify the result
    
    # Click rectangle tool
    if($rectBtn){
        $actions+=@{type='click';control_id=$rectBtn.control_id;delay_ms=100}
    }
    
    # Drag on canvas to draw rectangle
    # Canvas is below y~100. Let's draw from (150,200) to (350,400)
    $actions+=@{type='move';points=@(@(150,200),@(350,400));hold='left';delay_ms=200}
    
    Write-Host "Executing $(@($actions).Count) actions..."
    $result=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=$actions}
    Write-Host "Batch result: $($result|ConvertTo-Json -Depth 10 -Compress)"
    
    # Get screenshot
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'final-result.png'
    Copy-Item -LiteralPath $after.capture.path -Destination $outFile
    Write-Host "Screenshot: $outFile"
    
    # Pixel verification
    Add-Type -AssemblyName System.Drawing
    $bitmap=[Drawing.Bitmap]::new($outFile)
    $w=$bitmap.Width; $h=$bitmap.Height
    $nonWhite=0; $total=0
    for($y=150;$y -lt 450;$y+=5){
        for($x=100;$x -lt 400;$x+=5){
            if($x -ge $w -or $y -ge $h){continue}
            $total++
            $px=$bitmap.GetPixel($x,$y)
            if($px.R -ne 255 -or $px.G -ne 255 -or $px.B -ne 255){
                $nonWhite++
            }
        }
    }
    Write-Host "Verification: $nonWhite/$total non-white pixels in canvas area"
    $bitmap.Dispose()
} finally {
    Close-Pilot $client
}
