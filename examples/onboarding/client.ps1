# A tiny persistent native MCP client. Dot-source, then Open-Pilot / Call-Pilot / Close-Pilot.
# Both output streams are consumed; stdout remains JSON-RPC only.
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
function Send-Pilot($Client,[string]$Method,$Params,[int]$TimeoutMs=30000) {
    $Client.NextId++
    $id=$Client.NextId
    $Client.Process.StandardInput.WriteLine((@{jsonrpc='2.0';id=$id;method=$Method;params=$Params}|ConvertTo-Json -Depth 60 -Compress))
    $Client.Process.StandardInput.Flush()
    $read=$Client.Process.StandardOutput.ReadLineAsync()
    if(-not $read.Wait($TimeoutMs)){throw 'Response timeout: inspect target state before replaying actions.'}
    if($null -eq $read.Result){throw 'Server closed stdout; inspect stderr/desktop launch context.'}
    $r=$read.Result|ConvertFrom-Json
    if($r.id -ne $id){throw 'Unexpected response id'}
    if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
    return $r.result
}
function Call-Pilot($Client,[string]$Tool,$Arguments) {
    $timeout=if($Tool -eq 'execute_semantic'){610000}else{30000}
    $r=Send-Pilot $Client 'tools/call' @{name=$Tool;arguments=$Arguments} -TimeoutMs $timeout
    if($r.isError){throw ($r.structuredContent|ConvertTo-Json -Depth 30 -Compress)}
    return $r.structuredContent
}
function Close-Pilot($Client) {
    if(-not $Client){return}
    $p=$Client.Process
    if(-not $p.HasExited){$p.StandardInput.Close();if(-not $p.WaitForExit(3000)){$p.Kill();$p.WaitForExit()}}
    $stderr=$Client.Errors.GetAwaiter().GetResult()
    if($stderr){Write-Warning $stderr.Trim()}
    $p.Dispose()
}
