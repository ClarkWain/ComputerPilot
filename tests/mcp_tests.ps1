param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference='Stop'
$process=New-Object System.Diagnostics.Process
$process.StartInfo.FileName=$Executable
$process.StartInfo.Arguments='serve'
$process.StartInfo.UseShellExecute=$false
$process.StartInfo.CreateNoWindow=$true
$process.StartInfo.RedirectStandardInput=$true
$process.StartInfo.RedirectStandardOutput=$true
$process.StartInfo.RedirectStandardError=$true
$process.StartInfo.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
$process.StartInfo.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
$checks=0
function Assert-True($value,[string]$message){if(-not $value){throw $message};$script:checks++}
function Send-Request($request){$process.StandardInput.WriteLine(($request|ConvertTo-Json -Depth 30 -Compress));$process.StandardInput.Flush();$task=$process.StandardOutput.ReadLineAsync();if(-not $task.Wait(15000)){throw 'MCP response timeout'};if($null -eq $task.Result){throw 'Unexpected EOF'};return ($task.Result|ConvertFrom-Json)}
try{
    [void]$process.Start()
    $stderr=$process.StandardError.ReadToEndAsync()
    $r=Send-Request @{jsonrpc='2.0';id=1;method='tools/list'}
    Assert-True ($null -ne $r.error) 'Tools accepted before initialization'
    $r=Send-Request @{jsonrpc='2.0';id=2;method='initialize';params=@{protocolVersion='2025-06-18';capabilities=@{};clientInfo=@{name='native-test';version='1'}}}
    Assert-True ($r.result.protocolVersion -eq '2025-06-18') 'Protocol negotiation failed'
    Assert-True ($r.result.instructions -match 'SAME Windows session') 'Startup omitted desktop prerequisite'
    Assert-True ($r.result._meta.'desktopPilot/desktopPreflight'.ready -is [bool]) 'Startup omitted structured preflight'
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    $r=Send-Request @{jsonrpc='2.0';id=3;method='tools/list'}
    Assert-True ($r.result.tools.Count -eq 4) 'Expected exactly four tools'
    foreach($name in @('list_windows','get_window_state','execute_semantic','execute_batch')) {
        Assert-True ($r.result.tools.name -contains $name) ('Missing tool: '+$name)
    }
    foreach($name in @('check_environment','execute_single','desktop_connect','computer_query','computer_act','computer_semantic','computer_runtime','computer_inspect','computer_batch','computer_wait')) {
        $removed=Send-Request @{jsonrpc='2.0';id=40;method='tools/call';params=@{name=$name;arguments=@{}}}
        Assert-True ($removed.error.code -eq -32602) ('Removed tool still accepted: '+$name)
    }
    $batch=@($r.result.tools|Where-Object name -eq 'execute_batch')[0]
    Assert-True (-not ($batch.inputSchema.properties.PSObject.Properties.Name -contains 'state_id')) 'State bookkeeping leaked into public schema'
    $listTool=@($r.result.tools|Where-Object name -eq 'list_windows')[0]
    Assert-True (@($listTool.inputSchema.properties.PSObject.Properties).Count -eq 0) 'list_windows exposed parameters'
    $listing=Send-Request @{jsonrpc='2.0';id=50;method='tools/call';params=@{name='list_windows';arguments=@{}}}
    Assert-True (-not $listing.result.isError -and $listing.result.structuredContent.status -eq 'ok' -and $null -ne $listing.result.structuredContent.windows) 'Window enumeration failed'
    Assert-True (@($listing.result.content).Count -eq 0) 'Window list duplicated structured data in content'
    foreach($arguments in @(@{title='obsolete'},@{pid=1})) {
        $filtered=Send-Request @{jsonrpc='2.0';id=53;method='tools/call';params=@{name='list_windows';arguments=$arguments}}
        Assert-True ($filtered.result.isError -and $filtered.result.structuredContent.code -eq 'invalid_arguments') 'Window filters accepted'
        Assert-True (@($filtered.result.content).Count -eq 0) 'Tool error duplicated structured data in content'
    }
    $invalid=Send-Request @{jsonrpc='2.0';id=51;method='tools/call';params=@{name='execute_semantic';arguments=@{window_id='missing';actions=@(@{action='drawing.drawCircle';args=@{}})}}}
    Assert-True ($invalid.result.isError -and $invalid.result.structuredContent.code -eq 'unknown_window') 'Semantic tool not routed or unknown window accepted'
    $invalid=Send-Request @{jsonrpc='2.0';id=52;method='tools/call';params=@{name='execute_batch';arguments=@{window_id='missing';state_id='removed';actions=@()}}}
    Assert-True ($invalid.result.isError -and $invalid.result.structuredContent.code -eq 'invalid_arguments') 'Old parameters accepted silently'
    $process.StandardInput.WriteLine('not-json')
    $r=$process.StandardOutput.ReadLine()|ConvertFrom-Json
    Assert-True ($r.error.code -eq -32700) 'Malformed JSON code'
    $r=Send-Request @{jsonrpc='2.0';id=60;method='ping'}
    Assert-True ($r.id -eq 60 -and $null -eq $r.error) 'Server did not recover after malformed JSON'
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9999}}')
    $r=Send-Request @{jsonrpc='2.0';id=61;method='ping'}
    Assert-True ($r.id -eq 61 -and $null -eq $r.error) 'Standard cancellation notification broke protocol'
    $process.StandardInput.Close()
    Assert-True ($process.WaitForExit(10000)) 'Server did not terminate on EOF'
    Assert-True ($process.ExitCode -eq 0) 'Server failed on EOF'
    Write-Output "MCP PASS checks=$checks"
}finally{if($process.Id -and -not $process.HasExited){$process.Kill()};$process.Dispose()}
