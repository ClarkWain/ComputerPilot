param([string]$Executable, [string]$OutputDirectory='out/paint-reliability', [int]$PaintPid=0, [string]$ActionsFile)
$ErrorActionPreference='Stop'
$dir=[IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($dir)
$p=[Diagnostics.Process]::new()
$p.StartInfo.FileName=[IO.Path]::GetFullPath($Executable)
$p.StartInfo.Arguments='jsonl'
$p.StartInfo.UseShellExecute=$false
$p.StartInfo.CreateNoWindow=$true
$p.StartInfo.RedirectStandardInput=$true
$p.StartInfo.RedirectStandardOutput=$true
$p.StartInfo.RedirectStandardError=$true
$p.StartInfo.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
$p.StartInfo.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
[void]$p.Start()
$stderr=$p.StandardError.ReadToEndAsync()
function Invoke-Pilot($op,$a) {
 $p.StandardInput.WriteLine((@{id=1;operation=$op;args=$a}|ConvertTo-Json -Depth 40 -Compress));$p.StandardInput.Flush()
 $read=$p.StandardOutput.ReadLineAsync()
 if(-not $read.Wait(600000)){throw 'DesktopPilot timed out'}
 $r=$read.Result|ConvertFrom-Json
 if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
 $r.result
}
try {
 $pre=Invoke-Pilot 'system.preflight' @{}
 if(-not $pre.ready){throw ($pre|ConvertTo-Json -Depth 10 -Compress)}
 # Deliberately visible: this is a disposable interactive drawing test.
 $paint=if($PaintPid){Get-Process -Id $PaintPid}else{
  $created=Invoke-Pilot 'app.launch' @{executable=(Get-Command mspaint.exe).Source}
  Get-Process -Id $created.pid
 }
 [void]$paint.WaitForInputIdle(5000)
 $w=@((Invoke-Pilot 'window.list' @{pid=$paint.Id;includeHidden=$true}).windows|Where-Object {$_.className -eq 'MSPaintApp'})
 if($w.Count -ne 1){throw 'Disposable Paint not found uniquely'}
 $ref=$w[0].windowRef
 Invoke-Pilot 'window.restore' @{windowRef=$ref}|Out-Null
 Invoke-Pilot 'window.resize' @{windowRef=$ref;width=1800;height=1400}|Out-Null
 Invoke-Pilot 'window.activate' @{windowRef=$ref}|Out-Null
 @{pid=$paint.Id;windowRef=$ref}|ConvertTo-Json|Set-Content "$dir/window.json"
 $shapes=@(
  @{action='drawing.drawPolygon';args=@{points=@(@(80,80),@(240,80),@(240,240),@(80,240));fill=@(255,80,70);stroke=@{color=@(20,20,20);width=5}}},
  @{action='drawing.drawPolygon';args=@{points=@(0..59|ForEach-Object{$t=$_*2*[Math]::PI/60; ,@([int](400+80*[Math]::Cos($t)),[int](160+80*[Math]::Sin($t)))});fill=@(40,180,100);stroke=@{color=@(20,20,20);width=5}}}
 )
 $shapes+=@(Get-Content -Raw -LiteralPath "$PSScriptRoot/fixtures/paint-dense-flower.json"|ConvertFrom-Json)
 if($ActionsFile){$shapes=@(Get-Content -Raw -LiteralPath $ActionsFile|ConvertFrom-Json)}
 for($i=0;$i -lt $shapes.Count;$i++) {
  $timer=[Diagnostics.Stopwatch]::StartNew()
  $batch=if($ActionsFile){$shapes}else{@($shapes[$i])}
  $r=Invoke-Pilot 'semantic.execute' @{windowRef=$ref;actions=@($batch)}
  @{result=$r;elapsedMs=$timer.ElapsedMilliseconds}|ConvertTo-Json -Depth 30|Set-Content "$dir/result-$i.json"
  $c=Invoke-Pilot 'capture.window' @{windowRef=$ref;output="$dir/shape-$i.png"}
  Write-Output "shape=$i status=$($r.status) completed=$($r.completed) elapsedMs=$($timer.ElapsedMilliseconds) capture=$($c.path)"
  if($r.status -eq 'error'){throw ($r|ConvertTo-Json -Depth 15 -Compress)}
  Write-Output 'Dispatch finished; inspect the captured drawing for correctness and quality.'
  if($ActionsFile){break}
 }
} finally {$p.StandardInput.Close();[void]$p.WaitForExit(3000);$p.Dispose()}
