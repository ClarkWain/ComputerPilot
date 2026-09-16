param([Parameter(Mandatory=$true)][string]$Executable,[string]$OutputDirectory=(Join-Path $PWD 'out/onboarding'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'client.ps1')
$client=$null;$fixture=$null
$timer=[Diagnostics.Stopwatch]::StartNew()
try {
    $client=Open-Pilot $Executable
    $preflight=$client.Initialization._meta.'desktopPilot/desktopPreflight'
    if(-not $preflight.ready){throw ($preflight|ConvertTo-Json -Depth 20 -Compress)}
    $fixtureExe=Join-Path (Split-Path (Resolve-Path $Executable)) 'desktop-pilot-onboarding.exe'
    if(-not (Test-Path -LiteralPath $fixtureExe)){throw 'Build/package desktop-pilot-onboarding.exe first.'}
    # The helper starts hidden; its only UI is the deliberate disposable test canvas.
    $fixture=Start-Process -FilePath $fixtureExe -WindowStyle Hidden -PassThru
    [void]$fixture.WaitForInputIdle(5000)
    $windows=Call-Pilot $client 'list_windows' @{}
    $windows.windows=@($windows.windows | Where-Object { $_.pid -eq $fixture.Id })
    if(@($windows.windows).Count -ne 1){throw 'Fixture window is not unique; no input sent.'}
    $window=$windows.windows[0];$ref=$window.window_id
    $tree=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    if($tree.truncated){throw 'Incomplete fixture tree; no drawing sent.'}
    $nodes=@{}
    foreach($e in $tree.controls){if($e.name){$nodes[$e.name]=$e}}
    $rows=@('..RR.RR.','.RRRRRRR','.RRRRRRR','..RRRRR.','...RRR..','....R...','BB....YY','BB....YY')
    $palette=@{R='Red';B='Blue';Y='Yellow'}
    $colors=@{R=@(224,64,64);B=@(44,100,210);Y=@(244,210,48);'.'=@(255,255,255)}
    function Point($Name) {
        if(-not $nodes.ContainsKey($Name)){throw "Missing observed control: $Name"}
        $b=$nodes[$Name].bounds
        return @{x=[int][Math]::Floor($b.x+$b.width/2);y=[int][Math]::Floor($b.y+$b.height/2)}
    }
    # Validate every target before any drawing; all coordinates come from this run's UIA tree.
    foreach($key in @('R','B','Y')){$null=Point $palette[$key]}
    for($y=0;$y -lt 8;$y++){for($x=0;$x -lt 8;$x++){$null=Point "Cell $x $y"}}
    $steps=@()
    foreach($key in @('R','B','Y')) {
        $steps+=@{type='click';point=(Point $palette[$key]);delay_ms=40}
        for($y=0;$y -lt 8;$y++){for($x=0;$x -lt 8;$x++){
            if([string]$rows[$y][$x] -eq $key){$steps+=@{type='click';point=(Point "Cell $x $y");delay_ms=15}}
        }}
    }
    [void][IO.Directory]::CreateDirectory($OutputDirectory)
    $output=Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'actual.png'
    $result=Call-Pilot $client 'execute_batch' @{window_id=$ref;actions=$steps}
    $after=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='image'}
    Copy-Item -LiteralPath $after.capture.path -Destination $output
    # An independent read of the captured result, not input receipts.
    Add-Type -AssemblyName System.Drawing
    $bitmap=[Drawing.Bitmap]::new($output)
    $mismatch=@()
    try {for($y=0;$y -lt 8;$y++){for($x=0;$x -lt 8;$x++){
        $point=Point "Cell $x $y";$actual=$bitmap.GetPixel($point.x,$point.y);$expected=$colors[[string]$rows[$y][$x]]
        if($actual.R -ne $expected[0] -or $actual.G -ne $expected[1] -or $actual.B -ne $expected[2]){$mismatch+="$x,$y"}
    }}} finally {$bitmap.Dispose()}
    $report=@{status=if($mismatch.Count -eq 0){'passed'}else{'failed'};checkedCells=64;mismatchedCells=$mismatch;
        screenshot=$output;elapsedMs=$timer.ElapsedMilliseconds;steps=$steps.Count;
        scope='Disposable native fixture only; not Aseprite compatibility or artistic-quality certification.'}
    $report|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $OutputDirectory 'report.json') -Encoding UTF8
    $report|ConvertTo-Json -Depth 10
    if($mismatch.Count){throw 'Pixel verification failed; inspect actual.png and report.json. No automatic redraw.'}
} finally {
    # Only the helper process created above is closed; existing user apps/documents are untouched.
    if($fixture){if(-not $fixture.HasExited){[void]$fixture.CloseMainWindow();if(-not $fixture.WaitForExit(2000)){$fixture.Kill()}};$fixture.Dispose()}
    Close-Pilot $client
}
