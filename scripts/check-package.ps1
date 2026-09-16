param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
foreach($required in @('bin/desktop-pilot.exe','bin/desktop-pilot-onboarding.exe','LICENSE','README.md','AGENTS.md','THIRD_PARTY_NOTICES.md','docs/MCP.md','docs/PROTOCOL.md','docs/AGENT-API.md','docs/agent-tools.schema.json','docs/SEMANTIC-PROFILES.md','profiles/mspaint-classic-zh-CN/profile.json','skills/desktoppilot/SKILL.md','skills/desktoppilot/references/protocol.md','skills/desktoppilot/scripts/install.ps1','examples/onboarding/start.ps1','mcp.example.json')) {
    if(-not (Test-Path -LiteralPath (Join-Path $Path $required))) { throw "Missing package file: $required" }
}
$bad=Get-ChildItem -LiteralPath $Path -Recurse -File | Where-Object { $_.Extension -in @('.pt','.onnx','.safetensors','.pdb','.png','.jpg','.log') }
if($bad){throw 'Unexpected model, debug or local artifact in package'}
$config=Get-Content -LiteralPath (Join-Path $Path 'mcp.example.json') -Raw|ConvertFrom-Json
if($config.mcpServers.'desktop-pilot'.args[0] -ne 'serve'){throw 'Invalid MCP example'}
Write-Output 'Package checks passed'
