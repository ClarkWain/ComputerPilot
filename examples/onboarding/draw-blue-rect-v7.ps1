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
    
    # Step 2: Click "工具" (Tools) tab
    $toolsTab=$null
    foreach($c in $state.controls){
        if($c.name -eq '工具'){$toolsTab=$c;break}
    }
    if($toolsTab){
        $r1=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$toolsTab.control_id;delay_ms=500})}
        Write-Host "Clicked tools tab: $($r1|ConvertTo-Json -Compress)"
        
        # Step 3: Re-observe
        $state2=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
        Write-Host 'Controls after tools tab:'
        foreach($c in $state2.controls){
            $b=$c.bounds
            $bStr=''
            if($b -and $b.width -gt 0){$bStr=" x=$($b.x) y=$($b.y) w=$($b.width) h=$($b.height)"}
            Write-Host "  [$($c.role)] '$($c.name)' id=$($c.control_id)$bStr"
        }
        
        # Step 4: Look for rectangle tool
        $rectBtn=$null
        foreach($c in $state2.controls){
            if($c.name -match '矩形' -and $c.role -ne 'Window'){
                $rectBtn=$c
                Write-Host "Found rect: [$($c.role)] '$($c.name)' id=$($c.control_id)"
                break
            }
        }
        
        if($rectBtn){
            # Step 5: Click rectangle tool
            $r2=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='click';control_id=$rectBtn.control_id;delay_ms=300})}
            Write-Host "Clicked rect tool: $($r2|ConvertTo-Json -Compress)"
            
            # Step 6: Re-observe
            $state3=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
            
            # Step 7: Draw rectangle
            $r3=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=@(@{type='move';points=@(@(300,300),@(600,500));hold='left';delay_ms=300})}
            Write-Host "Drew: $($r3|ConvertTo-Json -Compress)"
        }
    }
    
    # Step 8: Get screenshot
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    $outDir=Join-Path $root 'out/blue-rect'
    [void][IO.Directory]::CreateDirectory($outDir)
    $outFile=Join-Path $outDir 'v7-result.png'
    Copy-Item -LiteralPath $after.capture.path -Destination $outFile
    Write-Host "Screenshot: $outFile"
    
    # Pixel verification
    Add-Type -AssemblyName System.Drawing
    $bitmap=[Drawing.Bitmap]::new($outFile)
    $w=$bitmap.Width; $h=$bitmap.Height
    Write-Host "Image: ${w}x${h}"
    $nonWhite=0; $total=0; $blue=0
    $samples=@()
    for($y=250;$y -lt 550;$y+=20){
        for($x=250;$x -lt 650;$x+=20){
            if($x -ge $w -or $y -ge $h){continue}
            $total++
            $px=$bitmap.GetPixel($x,$y)
            if($px.R -ne 255 -or $px.G -ne 255 -or $px.B -ne 255){
                $nonWhite++
                if($px.B -gt 150 -and $px.R -lt 100 -and $px.G -lt 100){$blue++}
                if($samples.Count -lt 5){$samples+= "($x,$y) R=$($px.R) G=$($px.G) B=$($px.B)"}
            }
        }
    }
    Write-Host "Verification: $nonWhite/$total non-white, $blue blue in (250,250)-(650,550)"
    if($samples.Count -gt 0){
        Write-Host "Samples:"
        foreach($s in $samples){Write-Host "  $s"}
    }
    $bitmap.Dispose()
} finally {
    Close-Pilot $client
}
