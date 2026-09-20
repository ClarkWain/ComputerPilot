param([string]$Actions='fresh-actions.json')
$ref=@{fromStep='target';path='/result/windows/0/windowRef'}
$steps=@(@{id='target';operation='window.list';args=@{titleContains='Aseprite'}},@{operation='window.activate';args=@{windowRef=$ref}})
$steps+=@(Get-Content $Actions -Raw|ConvertFrom-Json -AsHashtable|%{if(-not $_.ContainsKey("delayMs")){ $_.delayMs=100 }; $_})
$steps+=@{delayMs=250;operation='capture.window';args=@{windowRef=$ref;output=(Join-Path $PWD 'fresh-screen.png')}}
$q=@(@{jsonrpc='2.0';id=1;method='initialize';params=@{protocolVersion='2025-06-18';capabilities=@{};clientInfo=@{name='fresh-pixel';version='1'}}},@{jsonrpc='2.0';method='notifications/initialized'},@{jsonrpc='2.0';id=2;method='tools/call';params=@{name='computer_batch';arguments=@{output='summary';inputDefaults=@{windowRef=$ref;coordinateSpace='window_relative';expectedSize=@{width=925;height=690}};steps=$steps}}})
$q|%{$_|ConvertTo-Json -Depth 40 -Compress}|Set-Content -Encoding utf8 fresh-requests.jsonl
& ./build/core/Release/desktop-pilot.exe serve --input fresh-requests.jsonl --output fresh-responses.jsonl
Get-Content fresh-responses.jsonl|%{($_|ConvertFrom-Json).result.structuredContent}|ConvertTo-Json -Depth 15 -Compress


