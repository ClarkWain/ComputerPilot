# V3: Force 32x32 via CLI + Lua, then draw wizard.
$ErrorActionPreference='Stop'
$exe=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../build/core/Release/desktop-pilot.exe'))
$modelsDir=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../models/ocr'))
$outDir=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../out/wizard'))
$lua=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'make32.lua'))
[void][IO.Directory]::CreateDirectory($outDir)

# Kill any existing Aseprite.
Get-Process aseprite -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

# Launch Aseprite with the Lua script.
Write-Output "# Launch Aseprite with make32.lua"
Start-Process 'C:\Program Files\Aseprite\aseprite.exe' -ArgumentList "--script $lua"
Start-Sleep -Seconds 3

$p=[Diagnostics.Process]::new()
$p.StartInfo.FileName=$exe
$p.StartInfo.Arguments='jsonl'
$p.StartInfo.UseShellExecute=$false
$p.StartInfo.CreateNoWindow=$true
$p.StartInfo.RedirectStandardInput=$true
$p.StartInfo.RedirectStandardOutput=$true
$p.StartInfo.RedirectStandardError=$true
$p.StartInfo.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
$p.StartInfo.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
[void]$p.Start()
function Inv($op,$a){
 $p.StandardInput.WriteLine((@{id=1;operation=$op;args=$a}|ConvertTo-Json -Depth 40 -Compress));$p.StandardInput.Flush()
 $rd=$p.StandardOutput.ReadLineAsync()
 if(-not $rd.Wait(120000)){throw "timeout on $op"}
 $r=$rd.Result|ConvertFrom-Json
 if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
 $r.result
}
function Snap($tag){$c=Join-Path $outDir "$tag.png";Inv 'capture.window' @{windowRef=$script:ref;output=$c}|Out-Null;$c}
function OCR($path){(Inv 'vision.ocr' @{image=$path;ocrModels=$modelsDir;ocrMaxSide=2048}).textLines}
function FindText($lines,$regex){$lines | Where-Object {$_.text -match $regex} | Select-Object -First 1}
function Center($line){@{x=[int]($line.bounds.x + $line.bounds.width/2); y=[int]($line.bounds.y + $line.bounds.height/2)}}
function Assert($cond,$msg){if(-not $cond){throw "ASSERT: $msg"}}
function MoveTo($wx,$wy){
 $pts=New-Object 'System.Collections.ArrayList'
 [void]$pts.Add(@($wx,$wy))
 Inv 'input.move' @{windowRef=$script:ref;coordinateSpace='window_relative';expectedSize=$script:winBounds;points=$pts}|Out-Null
}
function Stroke($sx,$sy,$ex,$ey){
 $pts=New-Object 'System.Collections.ArrayList'
 [void]$pts.Add(@($sx,$sy))
 [void]$pts.Add(@($ex,$ey))
 Inv 'input.move' @{windowRef=$script:ref;coordinateSpace='window_relative';expectedSize=$script:winBounds;hold='left';points=$pts}|Out-Null
}
try {
 $w=(Inv 'window.list' @{titleContains='Aseprite'}).windows | Select-Object -First 1
 $script:ref=$w.windowRef
 Inv 'window.activate' @{windowRef=$ref}|Out-Null
 Start-Sleep -Milliseconds 500
 $wg=Inv 'window.get' @{windowRef=$ref}
 $script:winBounds=$wg.bounds
 Write-Output ("window: {0}x{1}" -f $wg.bounds.width,$wg.bounds.height)

 # Verify sprite exists and is 32x32 by clicking canvas + reading status coord range.
 # Move cursor to canvas center, then to canvas edge to bracket sprite dimensions.
 Inv 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.selectTool';args=@{tool='pencil'}})}|Out-Null
 Start-Sleep -Milliseconds 200

 # Zoom to 800%.
 Write-Output '=== zoom 800% ==='
 Inv 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.selectTool';args=@{tool='hand'}})}|Out-Null
 Start-Sleep -Milliseconds 200
 MoveTo ([int]($winBounds.width/2)) ([int]($winBounds.height/2))
 Start-Sleep -Milliseconds 200
 $currentZoom=0
 for($try=0;$try -lt 10;$try++){
   $s=OCR (Snap "v3-zoom$try")
   $zL=FindText $s '\d+\.\d+%'
   if($zL){$currentZoom=[double]($zL.text -replace '%','')}
   Write-Output ("  zoom={0}%" -f $currentZoom)
   if($currentZoom -ge 400){break}
   Inv 'input.scroll' @{delta=120}|Out-Null
   Start-Sleep -Milliseconds 400
 }
 Write-Output ("  OCR-reported zoom={0}% (may be stale)" -f $currentZoom)
 Assert ($currentZoom -ge 400) ("zoom too low: {0}" -f $currentZoom)

 # Calibrate BOTH origin AND actual pxSize by probing at two window positions.
 Write-Output '=== calibrate (2-point probe) ==='
 Inv 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.selectTool';args=@{tool='pencil'}})}|Out-Null
 Start-Sleep -Milliseconds 200
 function ProbeCoord($wx,$wy){
   MoveTo $wx $wy
   Start-Sleep -Milliseconds 350
   $lines=OCR (Snap "v3-probe-$wx-$wy")
   $statusY=$script:winBounds.height - 60
   $coord=$lines | Where-Object {$_.bounds.y -gt $statusY -and $_.text -match '(-?\d+)\s+(-?\d+)'} | Select-Object -First 1
   if($null -eq $coord){return $null}
   if($coord.text -match '(-?\d+)\s+(-?\d+)'){
     return @{x=[int]$matches[1]; y=[int]$matches[2]}
   }
 }
 $wx1=[int]($winBounds.width/2)-200; $wy1=[int]($winBounds.height/2)-100
 $wx2=[int]($winBounds.width/2)+200; $wy2=[int]($winBounds.height/2)+100
 $c1=ProbeCoord $wx1 $wy1
 $c2=ProbeCoord $wx2 $wy2
 Assert (($null -ne $c1) -and ($null -ne $c2)) 'probe OCR failed'
 Write-Output ("  probe1 window ({0},{1}) => canvas ({2},{3})" -f $wx1,$wy1,$c1.x,$c1.y)
 Write-Output ("  probe2 window ({0},{1}) => canvas ({2},{3})" -f $wx2,$wy2,$c2.x,$c2.y)
 $dx=$c2.x - $c1.x; $dy=$c2.y - $c1.y
 Assert (($dx -ne 0) -and ($dy -ne 0)) "canvas coord unchanged between probes ($dx,$dy)"
 $pxSizeX=[double]($wx2-$wx1)/$dx
 $pxSizeY=[double]($wy2-$wy1)/$dy
 Assert ([Math]::Abs($pxSizeX-$pxSizeY) -lt 2.0) "pxSize inconsistent x=$pxSizeX y=$pxSizeY"
 $pxSize=[int][Math]::Round(($pxSizeX+$pxSizeY)/2)
 $originX=[int]($wx1 - $c1.x*$pxSize)
 $originY=[int]($wy1 - $c1.y*$pxSize)
 Write-Output ("  actual pxSize={0}, origin=({1},{2})" -f $pxSize,$originX,$originY)
 Assert ($pxSize -ge 4 -and $pxSize -le 40) "pxSize out of sanity range: $pxSize"

 # Draw wizard.
 Write-Output '=== draw wizard ==='
 $wizard = @(
  '................................',
  '................................',
  '..............PP................',
  '.............PPPP...............',
  '............PPPPPP..............',
  '...........PPPPPPPP.............',
  '..........PPPPPPPPPP............',
  '.........PPPPPPPPPPPP...........',
  '........PPPPPPPPPPPPPP..........',
  '.......PPPPPPPPPPPPPPPP.........',
  '......PPPPPPPPPPPPPPPPPP........',
  '.....PPPPPPPPPPPPPPPPPPPP.......',
  '....PPPPPPPPPPPPPPPPPPPPPP......',
  '............PPPPPP..............',
  '...........PPFFFFPP.............',
  '..........PPFFEEFFPP............',
  '..........PPFFFFFFPP............',
  '...........PPFFFFPP.............',
  '............PPBBPP..............',
  '...........PBBBBBBP.............',
  '..........PBBBBBBBBP............',
  '.........PBBBBBBBBBBP...........',
  '........PRRRRRRRRRRRRP..........',
  '.......PRRRRRRRRRRRRRRP.........',
  '......PRRRRRRRRRRRRRRRRP........',
  '.....PRRRRRRRRRRRRRRRRRRP.......',
  '....PRRRRRRRRRRRRRRRRRRRRP......',
  '....PRRRRRRRRRRRRRRRRRRRRP......',
  '....PP..RRRRRRRRRRRRRR..PP......',
  '....PP..RRRRRRRRRRRRRR..PP......',
  '.....PPRRRRRRRRRRRRRRRRPP.......',
  '................................'
 )
 $strokes=@()
 for($row=0;$row -lt 32;$row++){
   $line=$wizard[$row]
   $col=0
   while($col -lt 32){
     if($line[$col] -eq '.'){$col++; continue}
     $start=$col
     while($col -lt 32 -and $line[$col] -ne '.'){$col++}
     $end=$col-1
     $sx=$originX+$start*$pxSize+[int]($pxSize/2)
     $sy=$originY+$row*$pxSize+[int]($pxSize/2)
     $ex=$originX+$end*$pxSize+[int]($pxSize/2)
     $ey=$originY+$row*$pxSize+[int]($pxSize/2)
     if($start -eq $end){$strokes+=@{type='click';x=$sx;y=$sy}}
     else{$strokes+=@{type='stroke';sx=$sx;sy=$sy;ex=$ex;ey=$ey}}
   }
 }
 Write-Output ("  {0} strokes" -f $strokes.Count)
 foreach($st in $strokes){
   if($st.type -eq 'stroke'){Stroke $st.sx $st.sy $st.ex $st.ey}
   else{Inv 'input.click' @{windowRef=$ref;coordinateSpace='window_relative';expectedSize=$winBounds;x=$st.x;y=$st.y}|Out-Null}
 }
 Start-Sleep -Milliseconds 400
 $snap=Snap 'v3-drawn'
 Write-Output ("  drawn: {0}" -f $snap)

 # Save.
 Write-Output '=== save ==='
 Inv 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.openMenu';args=@{name='File'}})}|Out-Null
 Start-Sleep -Milliseconds 400
 $s=OCR (Snap 'v3-filemenu')
 $sa=FindText $s '^Save As'
 Assert ($null -ne $sa) 'no Save As...'
 $saC=Center $sa
 Inv 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.click';args=@{x=$saC.x;y=$saC.y}})}|Out-Null
 Start-Sleep -Milliseconds 800
 $s=OCR (Snap 'v3-savedlg')
 $ok=FindText $s '^OK$'
 Assert ($null -ne $ok) 'no Save OK'
 $okC=Center $ok
 Inv 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.click';args=@{x=$okC.x;y=$okC.y}})}|Out-Null
 Start-Sleep -Milliseconds 800
 $s=OCR (Snap 'v3-post-ok')
 $yes=FindText $s '^Yes$'
 if($yes){
   $y=Center $yes
   Inv 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.click';args=@{x=$y.x;y=$y.y}})}|Out-Null
   Start-Sleep -Milliseconds 600
 }
 $final=Snap 'v3-final'
 Write-Output ("=== DONE. Final: {0}" -f $final)
} finally {$p.StandardInput.Close();[void]$p.WaitForExit(3000);$p.Dispose()}
