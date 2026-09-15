param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference='Stop'
$dir=Join-Path $PWD 'fixtures/transport'
[void][IO.Directory]::CreateDirectory($dir)
$utf8=[Text.UTF8Encoding]::new($false)
$payload=(('歌词第一行' + "`n`n" + '末行🙂') * 1500)
foreach($mode in @('jsonl','serve')) {
    $inputFile=Join-Path $dir "$mode-input.jsonl"
    $outputFile=Join-Path $dir "$mode-output.jsonl"
    $lines=@()
    if($mode -eq 'serve') {
        $lines+='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"file-test","version":"1"}}}'
        $lines+='{"jsonrpc":"2.0","method":"notifications/initialized"}'
        $request=@{jsonrpc='2.0';id=1;method='tools/call';params=@{name='computer_query';arguments=@{operation='runtime.describe';args=@{requestId=$payload}}}}
    } else { $request=@{id=1;operation='runtime.describe';args=@{requestId=$payload}} }
    $lines+=($request | ConvertTo-Json -Depth 12 -Compress)
    [IO.File]::WriteAllLines($inputFile,$lines,$utf8)
    & $Executable $mode --input $inputFile --output $outputFile
    if($LASTEXITCODE -ne 0) { throw "$mode file transport failed" }
    $response=([IO.File]::ReadAllLines($outputFile,$utf8)[-1] | ConvertFrom-Json)
    $result=if($mode -eq 'serve'){$response.result.structuredContent}else{$response.result}
    if($result.requestId -cne $payload) { throw "$mode long Unicode/newline roundtrip mismatch" }
    $before=(Get-FileHash -LiteralPath $inputFile).Hash
    & $Executable $mode --input $inputFile --output $inputFile 2>$null
    if($LASTEXITCODE -eq 0 -or (Get-FileHash -LiteralPath $inputFile).Hash -ne $before) { throw 'Same-path protection failed' }
}
Write-Output "FILE TRANSPORT PASS: long Unicode, blank lines, surrogate pairs, both protocols, same-path preservation"
