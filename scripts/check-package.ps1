param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $Path).Path
$program=if(Test-Path -LiteralPath (Join-Path $root 'bin/computer-pilot.exe')){'bin/computer-pilot.exe'}else{'bin/computer-pilot'}
$requiredFiles=@($program,'LICENSE','README.md','README.zh-CN.md','SECURITY.md','docs/INSTALLATION.md','docs/MIGRATION.md','AGENTS.md','THIRD_PARTY_NOTICES.md','docs/MCP.md','docs/PROTOCOL.md','docs/AGENT-API.md','docs/agent-tools.schema.json','docs/SEMANTIC-PROFILES.md','docs/REPLAY.md','docs/RECORDING.md','profiles/mspaint-classic-zh-CN/profile.json','profiles/mspaint-modern-zh-CN/profile.json','profiles/aseprite-vision-en/profile.json','skills/computerpilot/SKILL.md','skills/computerpilot/references/protocol.md','skills/computerpilot/scripts/install.ps1','examples/onboarding/start.ps1','examples/replays/flower-preview/replay.json','examples/replays/flower-preview/reference.png','mcp.example.json')
if($program.EndsWith('.exe')){$requiredFiles+='bin/computer-pilot-onboarding.exe'}
foreach($required in $requiredFiles) {
    if(-not (Test-Path -LiteralPath (Join-Path $Path $required))) { throw "Missing package file: $required" }
}
$publicMedia=@{
    'examples/replays/flower-preview/reference.png'='b069890335476df8523ed079c3aded0ba81797741371cfb094edf58d722c841b'
    'docs/media/brand-banner.svg'='5138230ea7edff946d1f4bca8452384996528512bd7d8cb9797e7af4de2359a9'
    'docs/media/flower-replay.gif'='37c57c372cf4f4d7810a6c0852a7a00e4971065e45fd12733454c4120ba94e0c'
    'docs/media/flower-replay.mp4'='2709e07df13c82d4f8038db7fead9c0f9bd177fc76aaa7b7af279395a0e88efd'
    'docs/media/logo.svg'='4cb657e2990f73a64103f70261b0e99adb87558104ea4afe39736979b27e0bf6'
    'docs/media/semantic-circle-en.png'='0df42ad0c81349945094bd0aab79b67e912d262fa78d509d11005d582ca47f98'
    'docs/media/semantic-circle.png'='0d354e031973d8fbcdf1544f7b676e230ce8345574082ceb9e4aba16708fa268'
    'docs/media/semantic-save-en.png'='b0cf3bb1787d23762c64b3b5dc152743face5c6fde368a361489a59eaf23803c'
    'docs/media/semantic-save.png'='392619243270e518dc95d024ce5fb75347559a9b54a3450e10ed9c9f586415a4'
    'docs/media/semantic-text-en.png'='833c5aee8a88fc5570566a2bf6197bfea17f16f8fa04272098953cc6294e1066'
    'docs/media/semantic-text.png'='2175bd9f31f2f9fa4f37edd5a14e336f043c83c0d616a48db8f5a06bc90460d6'
}
$bad=Get-ChildItem -LiteralPath $Path -Recurse -File | Where-Object { $_.Extension -in @('.pt','.onnx','.safetensors','.pdb','.png','.jpg','.gif','.mp4','.mov','.svg','.log','.jsonl') }
foreach($artifact in $bad){
    $relative=[IO.Path]::GetRelativePath($root,$artifact.FullName).Replace('\','/')
    # Only reviewed public media with matching content may ship.
    if($publicMedia.ContainsKey($relative) -and
       (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $publicMedia[$relative]){continue}
    throw "Unexpected model, debug or local artifact in package: $relative"
}
foreach($media in $publicMedia.Keys){if(-not(Test-Path -LiteralPath (Join-Path $Path $media))){throw "Missing public media: $media"}}
$config=Get-Content -LiteralPath (Join-Path $Path 'mcp.example.json') -Raw|ConvertFrom-Json
if($config.mcpServers.'computer-pilot'.args[0] -ne 'serve'){throw 'Invalid MCP example'}
$capabilities=& (Join-Path $Path $program) capabilities | ConvertFrom-Json
if($capabilities.version -ne '0.6.0'){throw "Unexpected packaged version: $($capabilities.version)"}
$aseprite=Get-Content -LiteralPath (Join-Path $Path 'profiles/aseprite-vision-en/profile.json') -Raw|ConvertFrom-Json
if($aseprite.actions.action -contains 'aseprite.saveAsDefault'){throw 'Unsafe Aseprite save action must not ship'}
Write-Output 'Package checks passed'
