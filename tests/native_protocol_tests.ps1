param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = (Resolve-Path -LiteralPath $Executable).Path
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true
$start.StandardInputEncoding = New-Object System.Text.UTF8Encoding($false)
$start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $start
if (-not $process.Start()) { throw 'Native process did not start' }
try {
    function Exchange([string]$line) {
        $process.StandardInput.WriteLine($line)
        $process.StandardInput.Flush()
        $reply = $process.StandardOutput.ReadLineAsync()
        if (-not $reply.Wait(10000)) { throw 'Native response timed out' }
        if ($null -eq $reply.Result) { throw 'Native process closed stdout unexpectedly' }
        return ($reply.Result | ConvertFrom-Json)
    }
    $hello = Exchange '{"id":"hello-1","operation":"native.hello","args":{}}'
    if ($hello.id -ne 'hello-1' -or $hello.result.protocolVersion -ne 1 -or
        $hello.result.processId -ne $process.Id -or
        -not $hello.result.preflight.session -or
        -not ($hello.result.operations -contains 'window.list') -or
        -not ($hello.result.operations -contains 'system.preflight') -or
        -not ($hello.result.operations -contains 'ui.click') -or
        -not ($hello.result.operations -contains 'ui.fill') -or
        -not ($hello.result.operations -contains 'ui.message_text') -or
        ($hello.result.operations -contains 'ui.fill_form')) { throw 'Invalid native capability handshake' }

    $preflight = Exchange '{"id":2,"operation":"system.preflight","args":{}}'
    if ($preflight.id -ne 2 -or $preflight.result.ready -isnot [bool] -or
        $preflight.result.session.processId -ne $process.Id) { throw 'Preflight did not come from native worker' }

    $unknown = Exchange '{"id":"unknown","operation":"semantic.perform","args":{}}'
    if ($unknown.id -ne 'unknown' -or $unknown.error.code -ne 'unknown_operation') { throw 'Business operation leaked into native protocol' }

    $bad = Exchange '{"id":"bad","operation":"window.list","args":[]}'
    if ($bad.id -ne 'bad' -or $bad.error.code -ne 'invalid_request') { throw 'Malformed request accepted' }

    $invalidJson = Exchange '{'
    if ($null -ne $invalidJson.id -or $invalidJson.error.code -ne 'invalid_json') { throw 'Invalid JSON was not reported' }

    $stale = Exchange '{"id":"utf8-测试","operation":"window.get","args":{"windowRef":"does-not-exist"}}'
    if ($stale.id -ne 'utf8-测试' -or $stale.error.code -ne 'invalid_arguments') { throw 'Worker-local reference was accepted' }

    $inputProbe = Exchange '{"id":"input-probe","operation":"input.click","args":{"windowRef":"does-not-exist","x":0,"y":0}}'
    if ($inputProbe.id -ne 'input-probe') { throw 'Input failure lost its request id' }
    if ($preflight.result.ready) {
        if ($inputProbe.error.code -ne 'target_reference_invalid' -or
            $inputProbe.error.dispatch -ne 'not_started') { throw 'Input did not validate its worker-local reference before dispatch' }
    } elseif ($inputProbe.error.code -ne 'desktop_environment_not_ready' -or
              $inputProbe.error.dispatch -ne 'not_started') {
        throw 'Input was dispatched despite failed preflight'
    }

    $pointProbe = Exchange '{"id":"point-probe","operation":"input.click","args":{"x":-999999,"y":-999999}}'
    if ($pointProbe.id -ne 'point-probe' -or $pointProbe.error.dispatch -ne 'not_started') {
        throw 'Unresolved pointer target was not blocked before dispatch'
    }

    $after = Exchange '{"id":"after","operation":"system.info","args":{}}'
    if ($after.id -ne 'after' -or -not $after.result) { throw 'Worker failed to continue after request errors' }

    $process.StandardInput.Close()
    if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw 'Native process did not exit cleanly' }
    Write-Output 'native-protocol PASS'
} finally {
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
}
