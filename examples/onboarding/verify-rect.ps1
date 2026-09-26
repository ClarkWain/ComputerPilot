param([string]$Executable)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(-not $Executable){
    $Executable=@((Join-Path $root 'bin/desktop-pilot.exe'),(Join-Path $root 'build/core/Release/desktop-pilot.exe'))|
        Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
}
. (Join-Path $PSScriptRoot 'client.ps1')
$client=$null
try {
    $client=Open-Pilot $Executable
    $windows=Call-Pilot $client 'list_windows' @{}
    $paintWindow=$null
    foreach($w in $windows.windows){
        if($w.title -match '画图|Paint'){$paintWindow=$w;break}
    }
    if(-not $paintWindow){throw 'No MSPaint window found.'}
    $ref=$paintWindow.window_id
    
    # Check if there's a selection (rectangle drawn) by looking at controls
    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    
    # Look for selection-related controls or shape handles
    Write-Host 'Controls that might indicate a drawn shape:'
    foreach($c in $state.controls){
        if($c.name -match '选择|矩形|形状|handle|Handle' -or $c.role -match 'Pane|Image'){
            $b=$c.bounds
            if($b){Write-Host "  [$($c.role)] '$($c.name)' x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
        }
    }
    
    # Get a fresh screenshot
    $img=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    $outFile=Join-Path $outDir 'verify.png'
    Copy-Item -LiteralPath $img.capture.path -Destination $outFile
    Write-Host "Verification screenshot: $outFile"
    
    # Use System.Drawing to check if there are non-white pixels in the canvas area
    Add-Type -AssemblyName System.Drawing
    $bitmap=[Drawing.Bitmap]::new($outFile)
    $w=$bitmap.Width; $h=$bitmap.Height
    Write-Host "Image size: ${w}x${h}"
    
    # Sample pixels in the area where we drew (100,200)-(300,400) in window coords
    # Image is 1366x768 (same as window), so coords should match
    $nonWhite=0; $blue=0; $total=0
    for($y=200;$y -lt 400;$y+=10){
        for($x=100;$x -lt 300;$x+=10){
            if($x -ge $w -or $y -ge $h){continue}
            $total++
            $px=$bitmap.GetPixel($x,$y)
            if($px.R -ne 255 -or $px.G -ne 255 -or $px.B -ne 255){
                $nonWhite++
                if($px.B -gt 150 -and $px.R -lt 100 -and $px.G -lt 100){$blue++}
            }
        }
    }
    Write-Host "Sampled $total pixels in (100,200)-(300,400)"
    Write-Host "Non-white: $nonWhite"
    Write-Host "Blue-ish: $blue"
    
    # Also check the center of our drawn area
    $cx=200; $cy=300
    if($cx -lt $w -and $cy -lt $h){
        $centerPx=$bitmap.GetPixel($cx,$cy)
        Write-Host "Center pixel (200,300): R=$($centerPx.R) G=$($centerPx.G) B=$($centerPx.B)"
    }
    $bitmap.Dispose()
} finally {
    Close-Pilot $client
}
