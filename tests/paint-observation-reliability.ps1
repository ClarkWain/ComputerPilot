param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [string]$OutputDirectory='out/paint-observation-reliability',
    [switch]$WaitForVisualReview
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../examples/onboarding/client.ps1')
$dir=[IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($dir)
$client=$null;$setup=$null;$paint=$null;$setupErrors=$null
function Save-Evidence($Name,$Value) {
    $Value | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath (Join-Path $dir $Name) -Encoding UTF8
}
function Setup-Call($Operation,$Arguments) {
    $setup.StandardInput.WriteLine((@{id=1;operation=$Operation;args=$Arguments}|ConvertTo-Json -Depth 30 -Compress))
    $setup.StandardInput.Flush()
    $read=$setup.StandardOutput.ReadLineAsync()
    if(-not $read.Wait(30000)){throw 'Fixture setup response timeout; no retry.'}
    $reply=$read.Result|ConvertFrom-Json
    if($reply.error){throw ($reply.error|ConvertTo-Json -Compress)}
    if($reply.result.status -eq 'error'){throw ($reply.result|ConvertTo-Json -Depth 20 -Compress)}
    $reply.result
}
function Tool($Name,$Arguments) {
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $reply=Send-Pilot $client 'tools/call' @{name=$Name;arguments=$Arguments} -TimeoutMs 610000
    $result=$reply.structuredContent
    if($reply.isError){Save-Evidence 'failure.json' $result;throw ($result|ConvertTo-Json -Depth 30 -Compress)}
    @{elapsedMs=$timer.ElapsedMilliseconds;result=$result}
}
try {
    $client=Open-Pilot $Executable
    $preflight=$client.Initialization._meta.'desktopPilot/desktopPreflight'
    Save-Evidence 'preflight.json' $preflight
    if($preflight.ready -isnot [bool] -or -not $preflight.ready){throw 'MCP worker preflight is not ready; no fixture or input started.'}
    $before=(Tool 'list_windows' @{}).result
    Save-Evidence 'existing-windows.json' $before
    # Developer transport is used only to create/fit our disposable fixture.
    # All observation and drawing below use the real four-tool MCP surface.
    $setup=[Diagnostics.Process]::new()
    $setup.StartInfo.FileName=(Resolve-Path -LiteralPath $Executable).Path
    $setup.StartInfo.Arguments='jsonl'
    $setup.StartInfo.UseShellExecute=$false;$setup.StartInfo.CreateNoWindow=$true
    $setup.StartInfo.RedirectStandardInput=$true;$setup.StartInfo.RedirectStandardOutput=$true;$setup.StartInfo.RedirectStandardError=$true
    $setup.StartInfo.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
    $setup.StartInfo.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
    [void]$setup.Start();$setupErrors=$setup.StandardError.ReadToEndAsync()
    $setupReady=Setup-Call 'system.preflight' @{}
    if($setupReady.ready -isnot [bool] -or -not $setupReady.ready){Save-Evidence 'setup-preflight.json' $setupReady;throw 'Fixture setup preflight not ready.'}
    $launched=Setup-Call 'app.launch' @{executable=(Get-Command mspaint.exe).Source}
    if(@($before.windows|Where-Object {$_.pid -eq $launched.pid}).Count){throw 'Launch returned an existing process; refusing to touch it.'}
    $paint=Get-Process -Id $launched.pid
    [void]$paint.WaitForInputIdle(5000)
    Save-Evidence 'fixture.json' @{pid=$paint.Id;startTime=$paint.StartTime;launch=$launched}
    $windows=(Tool 'list_windows' @{}).result.windows
    $targets=@($windows|Where-Object {$_.pid -eq $paint.Id})
    if($targets.Count -ne 1){throw 'New Paint window is not unique; no input sent.'}
    $target=$targets[0].window_id
    $observations=@()
    for($i=0;$i -lt 5;$i++) {
        $sample=Tool 'get_window_state' @{window_id=$target;mode='both'}
        Save-Evidence "both-$i.json" $sample
        if($sample.result.inspection.status -ne 'ok' -or @($sample.result.semantic.profiles).Count -ne 1){throw "Observation $i incomplete or no unique compatible profile; stopped without unchanged retry."}
        $observations+=@{elapsedMs=$sample.elapsedMs;inspection=$sample.result.inspection}
    }
    $image=Tool 'get_window_state' @{window_id=$target;mode='image'}
    Save-Evidence 'image.json' $image
    if($image.result.semantic.status -ne 'not_checked' -or $image.result.PSObject.Properties.Name -contains 'inspection'){throw 'Image mode unexpectedly inspected UIA.'}
    Write-Output "REVIEW_IMAGE=$($image.result.capture.path)"
    if($WaitForVisualReview) {
        $gate=Join-Path $dir 'visual-review-approved.txt'
        if(Test-Path -LiteralPath $gate){throw 'Visual review gate already exists; choose a fresh output directory.'}
        Write-Output "REVIEW_GATE=$gate"
        $wait=[Diagnostics.Stopwatch]::StartNew()
        while(-not (Test-Path -LiteralPath $gate)) {
            if($wait.Elapsed.TotalSeconds -gt 180){throw 'No visual review within three minutes; drawing skipped.'}
            Start-Sleep -Milliseconds 200
        }
    }
    $actions=@()
    # Small flower within the top-left 350 x 390 canvas area.
    $actions+=@{action='drawing.drawLine';args=@{from=@(190,160);to=@(190,340);stroke=@{color=@(44,130,65);width=8}}}
    foreach($center in @(@(190,95),@(250,140),@(228,210),@(152,210),@(130,140))) {
        $actions+=@{action='drawing.drawCircle';args=@{center=$center;radius=40;fill=@(246,120,170);stroke=@{color=@(190,60,115);width=3}}}
    }
    $actions+=@{action='drawing.drawCircle';args=@{center=@(190,160);radius=35;fill=@(255,211,69);stroke=@{color=@(194,137,35);width=3}}}
    Save-Evidence 'actions.json' $actions
    $draw=Tool 'execute_semantic' @{window_id=$target;profile=$sample.result.semantic.profiles[0].id;actions=$actions}
    Save-Evidence 'draw.json' $draw
    if($draw.result.status -ne 'ok' -or $draw.result.completed -ne $actions.Count){throw 'Scene not fully dispatched.'}
    $after=Tool 'get_window_state' @{window_id=$target;mode='image'}
    Save-Evidence 'after.json' $after
    $extension=[IO.Path]::GetExtension($after.result.capture.path)
    $artifact=Join-Path $dir "flower$extension"
    Copy-Item -LiteralPath $after.result.capture.path -Destination $artifact
    Save-Evidence 'summary.json' @{status='dispatched_visual_review_required';observations=$observations;imageMs=$image.elapsedMs;drawMs=$draw.elapsedMs;completed=$draw.result.completed;capture=$artifact}
    Write-Output "PASS observations=5 completed=$($draw.result.completed) imageMs=$($image.elapsedMs) drawMs=$($draw.elapsedMs) capture=$artifact"
} finally {
    # The Process object belongs only to the PID created above; never enumerate/kill other Paints.
    if($paint){if(-not $paint.HasExited){$paint.Kill();[void]$paint.WaitForExit(5000)};$paint.Dispose()}
    if($setup){if(-not $setup.HasExited){$setup.StandardInput.Close();if(-not $setup.WaitForExit(3000)){$setup.Kill();$setup.WaitForExit()}};if($setupErrors){$errors=$setupErrors.GetAwaiter().GetResult();if($errors){Write-Warning $errors}};$setup.Dispose()}
    Close-Pilot $client
}
