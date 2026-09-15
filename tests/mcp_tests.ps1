param([Parameter(Mandatory=$true)][string]$Executable,[string]$ModelsRoot='',[string]$Image='',[string]$Icon='')
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
    $r=Send-Request @{jsonrpc='2.0';id=1;method='tools/list'}
    Assert-True ($null -ne $r.error) 'Tools accepted before initialization'
    $r=Send-Request @{jsonrpc='2.0';id=2;method='initialize';params=@{protocolVersion='2025-06-18';capabilities=@{};clientInfo=@{name='native-test';version='1'}}}
    Assert-True ($r.result.protocolVersion -eq '2025-06-18') 'Protocol negotiation failed'
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    $r=Send-Request @{jsonrpc='2.0';id=3;method='tools/list'}
    Assert-True ($r.result.tools.Count -eq 6) 'Expected six MCP entry points'
    $r=Send-Request @{jsonrpc='2.0';id=4;method='tools/call';params=@{name='computer_runtime';arguments=@{}}}
    Assert-True ($r.result.structuredContent.operations -contains 'vision.ocr') 'OCR missing from registry'
    Assert-True ($r.result.structuredContent.operations -contains 'ui.fill_form') 'Form operation missing from registry'
    Assert-True ($r.result.structuredContent.operations -contains 'system.session') 'Session query missing from registry'
    $sessionCheck=Send-Request @{jsonrpc='2.0';id=904;method='tools/call';params=@{name='computer_query';arguments=@{operation='system.session';args=@{}}}}
    $sessionData=$sessionCheck.result.structuredContent
    Assert-True (-not $sessionCheck.result.isError -and $sessionData.lockState -in @('unknown','locked','unlocked')) 'Session query did not return a valid lock state'
    Assert-True ($sessionData.inputDesktopAccessible -is [bool]) 'Session desktop access must be a boolean'
    Assert-True ($sessionData.PSObject.Properties.Name -contains 'threadOnInputDesktop') 'Session query omitted unknown desktop state'
    Assert-True ($null -eq $sessionData.threadOnInputDesktop -or $sessionData.threadOnInputDesktop -is [bool]) 'Session desktop state must be boolean or null'
    $formCheck=Send-Request @{jsonrpc='2.0';id=401;method='tools/call';params=@{name='computer_act';arguments=@{operation='ui.fill_form';args=@{fields=@()}}}}
    Assert-True ($formCheck.result.isError -and $formCheck.result.content[0].text -notmatch 'Unknown operation') 'Form operation is not routed to validation'
    $text=$r.result.content[0].text|ConvertFrom-Json
    Assert-True ($text.operations.Count -eq $r.result.structuredContent.operations.Count) 'Structured/text mismatch'
    $r=Send-Request @{jsonrpc='2.0';id=5;method='tools/call';params=@{name='computer_query';arguments=@{operation='input.click';args=@{x=0;y=0}}}}
    Assert-True $r.result.isError 'Readonly tool accepted mutation'
    $r=Send-Request @{jsonrpc='2.0';id=6;method='tools/call';params=@{name='computer_act';arguments=@{operation='ui.get';args=@{elementRef='unknown'}}}}
    Assert-True $r.result.isError 'Unknown reference accepted'
    $r=Send-Request @{jsonrpc='2.0';id=7;method='tools/call';params=@{name='computer_query';arguments=@{operation='runtime.describe'}}}
    Assert-True ($r.result.structuredContent.nativeQuery.operation -eq 'ui.find') 'Operation help unavailable'
    $r=Send-Request @{jsonrpc='2.0';id=8;method='tools/call';params=@{name='computer_wait';arguments=@{operation='runtime.capabilities';pointer='/pythonRequired';equals=$false;timeoutMs=0}}}
    Assert-True $r.result.structuredContent.matched 'Wait equality failed'
    $r=Send-Request @{jsonrpc='2.0';id=9;method='tools/call';params=@{name='computer_batch';arguments=@{steps=@(@{operation='runtime.capabilities'},@{operation='unknown'},@{operation='runtime.capabilities'})}}}
    Assert-True ($r.result.structuredContent.completed -eq 1 -and $r.result.structuredContent.steps.Count -eq 2) 'Batch did not stop after failure'
    $r=Send-Request @{jsonrpc='2.0';id=91;method='tools/call';params=@{name='computer_batch';arguments=@{steps=@(@{id='describe';operation='runtime.describe'},@{operation='runtime.describe';args=@{unused=@{fromStep='describe';path='/result/nativeQuery/operation'}}})}}}
    Assert-True ($r.result.structuredContent.completed -eq 2) 'Batch reference resolution failed'
    $r=Send-Request @{jsonrpc='2.0';id=901;method='tools/call';params=@{name='computer_wait';arguments=@{operation='runtime.capabilities';pointer='/pythonRequired';equals=$false;timeoutMs=0;output='summary'}}}
    Assert-True ($r.result.structuredContent.matched -and $r.result.structuredContent.polls -eq 1 -and $null -eq $r.result.structuredContent.result) 'Summary wait leaked payload or failed matching'
    $r=Send-Request @{jsonrpc='2.0';id=902;method='tools/call';params=@{name='computer_batch';arguments=@{metrics=$true;output='last';steps=@(@{id='wait';delayMs=120;tool='computer_wait';arguments=@{operation='runtime.capabilities';pointer='/pythonRequired';equals=$true;timeoutMs=0;output='summary'}},@{operation='runtime.describe'})}}}
    Assert-True ($r.result.structuredContent.completed -eq 0 -and $r.result.structuredContent.steps[0].result.matched -eq $false -and $null -eq $r.result.structuredContent.steps[0].result.result) 'Summary timeout did not stop batch'
    Assert-True ($r.result.structuredContent.metrics.steps.Count -eq 1 -and $r.result.structuredContent.metrics.steps[0].beforeDispatchMs -ge 110 -and $r.result.structuredContent.metrics.elapsedMs -ge 110) 'Batch timing missing delay or failed step'
    $r=Send-Request @{jsonrpc='2.0';id=903;method='tools/call';params=@{name='computer_wait';arguments=@{operation='runtime.capabilities';pointer='/pythonRequired';equals=$false;output='invalid'}}}
    Assert-True $r.result.isError 'Invalid wait output accepted'
    # New batch features use read-only fixture operations to avoid touching the user's desktop.
    $condition=@{operation='runtime.capabilities';pointer='/pythonRequired';equals=$false}
    $r=Send-Request @{jsonrpc='2.0';id=910;method='tools/call';params=@{name='computer_batch';arguments=@{output='summary';steps=@(@{operation='runtime.describe';before=$condition;after=$condition})}}}
    Assert-True ($r.result.structuredContent.completed -eq 1 -and $null -eq $r.result.structuredContent.result -and $null -eq $r.result.structuredContent.steps) 'Compact successful batch leaked payload'
    foreach($phase in @('before','after')) {
        $step=@{id='checked';operation='runtime.describe'}
        $step[$phase]=@{operation='runtime.capabilities';pointer='/pythonRequired';equals=$true}
        $r=Send-Request @{jsonrpc='2.0';id=911;method='tools/call';params=@{name='computer_batch';arguments=@{output='summary';metrics=$true;steps=@($step,@{operation='unknown'})}}}
        $data=$r.result.structuredContent
        Assert-True ($r.result.isError -and $data.completed -eq 0 -and $data.failedStep -eq 'checked' -and $data.phase -eq $phase) 'Failed condition did not stop batch at correct phase'
        Assert-True ($data.dispatchAttempted -eq ($phase -eq 'after') -and $data.metrics.steps.Count -eq 1) 'Condition failure lost dispatch state or duplicated metrics'
    }
    $r=Send-Request @{jsonrpc='2.0';id=912;method='tools/call';params=@{name='computer_batch';arguments=@{output='summary';inputDefaults=@{windowRef='invalid';coordinateSpace='window_relative'};steps=@(@{operation='input.move';args=@{x=1;y=1}})}}}
    Assert-True ($r.result.isError -and $r.result.structuredContent.completed -eq 0) 'Input defaults did not bind invalid window before dispatch'
    $r=Send-Request @{jsonrpc='2.0';id=913;method='tools/call';params=@{name='computer_batch';arguments=@{steps=@(@{operation='runtime.describe';before=@{operation='input.click';pointer='/status';equals='ok'}})}}}
    Assert-True $r.result.isError 'Mutating batch condition accepted'
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $r=Send-Request @{jsonrpc='2.0';id=92;method='tools/call';params=@{name='computer_batch';arguments=@{output='last';steps=@(@{operation='runtime.describe'},@{delayMs=120;tool='computer_wait';arguments=@{operation='runtime.capabilities';pointer='/pythonRequired';equals=$false;timeoutMs=0}})}}}
    Assert-True ($r.result.structuredContent.completed -eq 2 -and $r.result.structuredContent.result.matched -and $timer.ElapsedMilliseconds -ge 120) 'Delayed batch or nested wait failed'
    Assert-True ($null -eq $r.result.structuredContent.steps) 'Last output leaked intermediate results'
    $r=Send-Request @{jsonrpc='2.0';id=93;method='tools/call';params=@{name='computer_batch';arguments=@{steps=@(@{tool='computer_wait';arguments=@{operation='runtime.capabilities';pointer='/pythonRequired';equals=$true;timeoutMs=0}},@{operation='runtime.describe'})}}}
    Assert-True ($r.result.structuredContent.completed -eq 0 -and $r.result.structuredContent.status -eq 'partial') 'Batch continued after wait timeout'
    $r=Send-Request @{jsonrpc='2.0';id=94;method='tools/call';params=@{name='computer_batch';arguments=@{steps=@(@{operation='runtime.describe';delayMs=-1})}}}
    Assert-True $r.result.isError 'Negative delay accepted'
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":95,"method":"tools/call","params":{"name":"computer_batch","arguments":{"steps":[{"operation":"runtime.describe","delayMs":30000}]}}}')
    Start-Sleep -Milliseconds 100
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":95}}')
    $task=$process.StandardOutput.ReadLineAsync()
    Assert-True ($task.Wait(3000)) 'Batch delay cancellation blocked'
    $r=$task.Result|ConvertFrom-Json
    Assert-True ($r.id -eq 95 -and $r.result.structuredContent.completed -eq 0) 'Cancelled delayed step executed'
    $process.StandardInput.WriteLine('not-json')
    $r=$process.StandardOutput.ReadLine()|ConvertFrom-Json
    Assert-True ($r.error.code -eq -32700) 'Malformed JSON code'
    $r=Send-Request @{jsonrpc='2.0';id=10;method='ping'}
    Assert-True ($r.id -eq 10 -and $null -eq $r.error) 'Server did not recover after malformed JSON'
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"computer_wait","arguments":{"operation":"runtime.capabilities","pointer":"/pythonRequired","equals":true,"timeoutMs":30000}}}')
    Start-Sleep -Milliseconds 100
    $r=Send-Request @{jsonrpc='2.0';id=21;method='ping'}
    Assert-True ($r.id -eq 21) 'Ping blocked by an active wait'
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":20}}')
    $task=$process.StandardOutput.ReadLineAsync()
    Assert-True ($task.Wait(5000)) 'Cancellation response timed out'
    $r=$task.Result|ConvertFrom-Json
    Assert-True ($r.id -eq 20 -and $r.result.isError) 'Cancellation did not finish the wait'
    if($ModelsRoot){
        $r=Send-Request @{jsonrpc='2.0';id=30;method='tools/call';params=@{name='computer_query';arguments=@{operation='vision.parse';args=@{image=$Image;model=(Join-Path $ModelsRoot 'icon_detect_v3/model.pt');ocrModels=(Join-Path $ModelsRoot 'ocr')}}}}
        Assert-True (-not $r.result.isError -and $r.result.structuredContent.elements.Count -eq 11) 'MCP vision pipeline failed'
        $r.result.structuredContent|ConvertTo-Json -Depth 30|Set-Content 'fixtures/mcp-vision.json' -Encoding utf8
    }
    $process.StandardInput.Close()
    Assert-True ($process.WaitForExit(10000)) 'Server did not terminate on EOF'
    Assert-True ($process.ExitCode -eq 0) 'Server failed on EOF'
    Write-Output "MCP PASS checks=$checks"
}finally{if($process.Id -and -not $process.HasExited){$process.Kill()};$process.Dispose()}
