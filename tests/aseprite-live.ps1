$ErrorActionPreference='Stop'
$exe=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../build/core/Release/desktop-pilot.exe'))
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
function Invoke-Pilot($op,$a){
 $p.StandardInput.WriteLine((@{id=1;operation=$op;args=$a}|ConvertTo-Json -Depth 40 -Compress));$p.StandardInput.Flush()
 $read=$p.StandardOutput.ReadLineAsync()
 if(-not $read.Wait(120000)){throw "timeout on $op"}
 $r=$read.Result|ConvertFrom-Json
 if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
 $r.result
}
try {
 $w=(Invoke-Pilot 'window.list' @{titleContains='Aseprite'}).windows | Select-Object -First 1
 if(-not $w){throw 'No Aseprite window'}
 $ref=$w.windowRef
 Invoke-Pilot 'window.activate' @{windowRef=$ref}|Out-Null
 Start-Sleep -Milliseconds 300

 # Test 1: keyChord — press B (pencil tool). No visible verification, but should not error.
 Write-Output '# Test 1: aseprite.keyChord [B] (pencil)'
 $r1=Invoke-Pilot 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.keyChord';args=@{keys=@('B')}})}
 $r1|ConvertTo-Json -Depth 8 -Compress | Write-Output

 # Test 2: openMenu View
 Write-Output ''
 Write-Output '# Test 2: aseprite.openMenu View (real OCR)'
 $timer=[Diagnostics.Stopwatch]::StartNew()
 $r2=Invoke-Pilot 'semantic.execute' @{windowRef=$ref;actions=@(@{action='aseprite.openMenu';args=@{name='View'}})}
 $timer.Stop()
 Write-Output ("elapsedMs=$($timer.ElapsedMilliseconds)")
 $r2|ConvertTo-Json -Depth 8 -Compress | Write-Output

 # Capture window post-menu to observe if it opened.
 $out=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../out/aseprite-probe/after-view.png'))
 Invoke-Pilot 'capture.window' @{windowRef=$ref;output=$out}|Out-Null
 Write-Output "capture=$out"

 # Close the menu if it opened.
 Invoke-Pilot 'input.key_chord' @{windowRef=$ref;keys=@('ESC')}|Out-Null
} finally {$p.StandardInput.Close();[void]$p.WaitForExit(3000);$p.Dispose()}
