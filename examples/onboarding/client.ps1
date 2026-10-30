# A tiny persistent native MCP client. Dot-source, then Open-Pilot / Call-Pilot / Close-Pilot.
# Both output streams are consumed; stdout remains JSON-RPC only.
function Get-PilotPreflight($Client) {
    $preflight=$Client.Initialization.serverInfo._meta.'desktopPilot/desktopPreflight'
    if($null -eq $preflight){$preflight=$Client.Initialization._meta.'desktopPilot/desktopPreflight'}
    if($null -eq $preflight -or $preflight.ready -isnot [bool]){throw 'Missing desktop preflight; update the launcher before sending input.'}
    return $preflight
}
function Find-PilotFixture([string]$Executable) {
    $root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $fixture=@((Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $Executable).Path) 'desktop-pilot-onboarding.exe'),
        $(if($env:DP_NATIVE_EXE){Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($env:DP_NATIVE_EXE))) 'desktop-pilot-onboarding.exe'}),
        (Join-Path $root 'build/release/Release/desktop-pilot-onboarding.exe')) |
        Where-Object {$_ -and (Test-Path -LiteralPath $_)} | Select-Object -First 1
    if(-not $fixture){throw 'Build desktop-pilot-onboarding.exe with the windows-release preset first.'}
    return $fixture
}
function Open-Pilot([string]$Executable) {
    $p=[Diagnostics.Process]::new()
    $resolved=(Resolve-Path -LiteralPath $Executable).Path
    if([IO.Path]::GetExtension($resolved) -ieq '.cmd'){
        $bundle=Split-Path -Parent $resolved
        $p.StartInfo.FileName=Join-Path $bundle 'runtime/node.exe'
        $p.StartInfo.ArgumentList.Add((Join-Path $bundle 'node/dist/src/index.js'))
    }elseif([IO.Path]::GetExtension($resolved) -ieq '.js'){
        $p.StartInfo.FileName=(Get-Command node -ErrorAction Stop).Source
        $p.StartInfo.ArgumentList.Add($resolved)
    }else{
        $p.StartInfo.FileName=$resolved
        $p.StartInfo.ArgumentList.Add('serve')
    }
    $p.StartInfo.UseShellExecute=$false
    $p.StartInfo.CreateNoWindow=$true
    $p.StartInfo.RedirectStandardInput=$true
    $p.StartInfo.RedirectStandardOutput=$true
    $p.StartInfo.RedirectStandardError=$true
    $p.StartInfo.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
    $p.StartInfo.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
    [void]$p.Start()
    $client=@{Process=$p;Errors=$p.StandardError.ReadToEndAsync();NextId=0}
    try {
        $init=Send-Pilot $client 'initialize' @{protocolVersion='2025-06-18';capabilities=@{};clientInfo=@{name='onboarding';version='1'}}
        $client.Initialization=$init
        $p.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
        $p.StandardInput.Flush()
        return $client
    } catch { Close-Pilot $client; throw }
}
function Send-Pilot($Client,[string]$Method,$Params,[ValidateRange(1,2147483647)][int]$TimeoutMs=30000) {
    if($Client.Closed -or $Client.Faulted){throw 'Client is unusable: Close-Pilot, reconnect and inspect target state before deciding remaining actions. Do not blindly resend.'}
    try {
        $Client.NextId++
        $id=$Client.NextId
        $Client.Process.StandardInput.WriteLine((@{jsonrpc='2.0';id=$id;method=$Method;params=$Params}|ConvertTo-Json -Depth 60 -Compress))
        $Client.Process.StandardInput.Flush()
        $read=$Client.Process.StandardOutput.ReadLineAsync()
        if(-not $read.Wait($TimeoutMs)){throw 'Response timeout'}
        if($null -eq $read.Result){throw 'Server closed stdout; inspect stderr/desktop launch context'}
        $r=$read.Result|ConvertFrom-Json -ErrorAction Stop
        if($r.id -ne $id){throw 'Unexpected response id'}
    } catch {
        $Client.Faulted=$true
        throw "$_; Close-Pilot, reconnect and inspect target state before deciding remaining actions. Do not blindly resend."
    }
    if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
    return $r.result
}
function Call-Pilot($Client,[string]$Tool,$Arguments,[ValidateRange(1,2147483647)][int]$TimeoutMs) {
    $timeout=if($PSBoundParameters.ContainsKey('TimeoutMs')){$TimeoutMs}elseif($Tool -eq 'execute_semantic'){610000}else{30000}
    if(-not $PSBoundParameters.ContainsKey('TimeoutMs') -and $Tool -eq 'execute_batch'){
        # Only valid schema delays affect the budget: at most 256 * 10000 ms.
        foreach($action in ($Arguments.actions | Select-Object -First 256)){
            $delay=$action.delay_ms
            if(($delay -is [int] -or $delay -is [long]) -and $delay -ge 0 -and $delay -le 10000){$timeout+=$delay}
        }
    }
    $r=Send-Pilot $Client 'tools/call' @{name=$Tool;arguments=$Arguments} -TimeoutMs $timeout
    if($r.isError){throw ($r.structuredContent|ConvertTo-Json -Depth 30 -Compress)}
    return $r.structuredContent
}
function Close-Pilot($Client) {
    if(-not $Client -or $Client.Closed){return}
    $Client.Closed=$true
    $p=$Client.Process
    if(-not $p.HasExited){$p.StandardInput.Close();if(-not $p.WaitForExit(3000)){$p.Kill();$p.WaitForExit()}}
    $stderr=$Client.Errors.GetAwaiter().GetResult()
    if($stderr){Write-Warning $stderr.Trim()}
    $p.Dispose()
}
