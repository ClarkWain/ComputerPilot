param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $Path).Path
$program=if(Test-Path -LiteralPath (Join-Path $root 'bin/desktop-pilot.exe')){'bin/desktop-pilot.exe'}else{'bin/desktop-pilot'}
$requiredFiles=@($program,'LICENSE','README.md','AGENTS.md','THIRD_PARTY_NOTICES.md','docs/MCP.md','docs/PROTOCOL.md','docs/AGENT-API.md','docs/agent-tools.schema.json','docs/SEMANTIC-PROFILES.md','docs/REPLAY.md','docs/RECORDING.md','profiles/mspaint-classic-zh-CN/profile.json','profiles/mspaint-modern-zh-CN/profile.json','profiles/aseprite-vision-en/profile.json','skills/desktoppilot/SKILL.md','skills/desktoppilot/references/protocol.md','skills/desktoppilot/scripts/install.ps1','examples/onboarding/start.ps1','examples/replays/flower-preview/replay.json','examples/replays/flower-preview/reference.png','mcp.example.json')
if($program.EndsWith('.exe')){$requiredFiles+='bin/desktop-pilot-onboarding.exe'}
foreach($required in $requiredFiles) {
    if(-not (Test-Path -LiteralPath (Join-Path $Path $required))) { throw "Missing package file: $required" }
}
$bad=Get-ChildItem -LiteralPath $Path -Recurse -File | Where-Object { $_.Extension -in @('.pt','.onnx','.safetensors','.pdb','.png','.jpg','.log','.jsonl') }
foreach($artifact in $bad){
    $relative=[IO.Path]::GetRelativePath($root,$artifact.FullName).Replace('\','/')
    # Permit only the intentional, fixed example artwork. Other screenshots,
    # recordings, models and debug artifacts must continue to fail packaging.
    if($relative -ceq 'examples/replays/flower-preview/reference.png' -and
       (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash -eq 'b069890335476df8523ed079c3aded0ba81797741371cfb094edf58d722c841b'){continue}
    throw "Unexpected model, debug or local artifact in package: $relative"
}
$config=Get-Content -LiteralPath (Join-Path $Path 'mcp.example.json') -Raw|ConvertFrom-Json
if($config.mcpServers.'desktop-pilot'.args[0] -ne 'serve'){throw 'Invalid MCP example'}
$capabilities=& (Join-Path $Path $program) capabilities | ConvertFrom-Json
if($capabilities.version -ne '0.5.0'){throw "Unexpected packaged version: $($capabilities.version)"}
$aseprite=Get-Content -LiteralPath (Join-Path $Path 'profiles/aseprite-vision-en/profile.json') -Raw|ConvertFrom-Json
if($aseprite.actions.action -contains 'aseprite.saveAsDefault'){throw 'Unsafe Aseprite save action must not ship'}
Write-Output 'Package checks passed'
