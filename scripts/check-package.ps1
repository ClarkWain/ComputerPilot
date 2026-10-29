param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $Path).Path
$program=if(Test-Path -LiteralPath (Join-Path $root 'bin/desktop-pilot.exe')){'bin/desktop-pilot.exe'}else{'bin/desktop-pilot'}
$requiredFiles=@($program,'LICENSE','README.md','AGENTS.md','THIRD_PARTY_NOTICES.md','docs/MCP.md','docs/PROTOCOL.md','docs/AGENT-API.md','docs/agent-tools.schema.json','docs/SEMANTIC-PROFILES.md','docs/REPLAY.md','docs/RECORDING.md','profiles/mspaint-classic-zh-CN/profile.json','profiles/mspaint-modern-zh-CN/profile.json','profiles/aseprite-vision-en/profile.json','skills/desktoppilot/SKILL.md','skills/desktoppilot/references/protocol.md','skills/desktoppilot/scripts/install.ps1','examples/onboarding/start.ps1','examples/replays/flower-preview/replay.json','examples/replays/flower-preview/reference.png','mcp.example.json')
if($program.EndsWith('.exe')){$requiredFiles+='bin/desktop-pilot-onboarding.exe'}
foreach($required in $requiredFiles) {
    if(-not (Test-Path -LiteralPath (Join-Path $Path $required))) { throw "Missing package file: $required" }
}
$publicMedia=@{
    'examples/replays/flower-preview/reference.png'='b069890335476df8523ed079c3aded0ba81797741371cfb094edf58d722c841b'
    'docs/media/semantic-circle.png'='0d354e031973d8fbcdf1544f7b676e230ce8345574082ceb9e4aba16708fa268'
    'docs/media/semantic-text.png'='c68bf0d5fd47c8581c2151f0a9aad1e8cbb3e0a73fd2717f6cd9daf0685cbf19'
    'docs/media/semantic-save.png'='392619243270e518dc95d024ce5fb75347559a9b54a3450e10ed9c9f586415a4'
    'docs/media/flower-replay.gif'='37c57c372cf4f4d7810a6c0852a7a00e4971065e45fd12733454c4120ba94e0c'
    'docs/media/flower-replay.mp4'='2709e07df13c82d4f8038db7fead9c0f9bd177fc76aaa7b7af279395a0e88efd'
}
$bad=Get-ChildItem -LiteralPath $Path -Recurse -File | Where-Object { $_.Extension -in @('.pt','.onnx','.safetensors','.pdb','.png','.jpg','.gif','.mp4','.mov','.log','.jsonl') }
foreach($artifact in $bad){
    $relative=[IO.Path]::GetRelativePath($root,$artifact.FullName).Replace('\','/')
    # Only reviewed public media with matching content may ship.
    if($publicMedia.ContainsKey($relative) -and
       (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $publicMedia[$relative]){continue}
    throw "Unexpected model, debug or local artifact in package: $relative"
}
$config=Get-Content -LiteralPath (Join-Path $Path 'mcp.example.json') -Raw|ConvertFrom-Json
if($config.mcpServers.'desktop-pilot'.args[0] -ne 'serve'){throw 'Invalid MCP example'}
$capabilities=& (Join-Path $Path $program) capabilities | ConvertFrom-Json
if($capabilities.version -ne '0.5.0'){throw "Unexpected packaged version: $($capabilities.version)"}
$aseprite=Get-Content -LiteralPath (Join-Path $Path 'profiles/aseprite-vision-en/profile.json') -Raw|ConvertFrom-Json
if($aseprite.actions.action -contains 'aseprite.saveAsDefault'){throw 'Unsafe Aseprite save action must not ship'}
Write-Output 'Package checks passed'
