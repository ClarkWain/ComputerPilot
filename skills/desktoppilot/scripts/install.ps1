param([string]$SkillsDirectory,[switch]$Update)
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=[IO.Path]::GetFullPath((Join-Path $source '../..'))
if(-not $SkillsDirectory) {
    $base=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'}
    $SkillsDirectory=Join-Path $base 'skills'
}
$destination=[IO.Path]::GetFullPath((Join-Path $SkillsDirectory 'desktoppilot'))
if($source -eq $destination){throw 'Source and installation are the same directory.'}
if((Test-Path -LiteralPath $destination) -and -not $Update){throw 'Installation exists. Use -Update to overwrite skill files explicitly.'}
[void][IO.Directory]::CreateDirectory($destination)
Get-ChildItem -LiteralPath $source | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force}
$entry=@((Join-Path $root 'node/dist/src/index.js'),
    (Join-Path $root 'out/dist/DesktopPilot-Node/desktop-pilot-mcp.cmd'),
    (Join-Path $root 'desktop-pilot-mcp.cmd'),(Join-Path $root 'bin/desktop-pilot.exe')) |
    Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
$server=$null
if($entry){
    if([IO.Path]::GetExtension($entry) -ieq '.cmd'){
        $bundle=Split-Path -Parent $entry
        $server=@{command=(Join-Path $bundle 'runtime/node.exe');
            args=@((Join-Path $bundle 'node/dist/src/index.js'))}
    }elseif([IO.Path]::GetExtension($entry) -ieq '.js'){
        $server=@{command=(Get-Command node -ErrorAction Stop).Source;args=@($entry)}
    }else{$server=@{command=$entry;args=@('serve')}}
}
@{root=$root;executable=$server.command;args=@($server.args);note='Local installation hint, verify existence before use; no MCP or permission settings changed.'} |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $destination 'installation.json') -Encoding UTF8
Write-Output "Installed skill: $destination. Start a new agent session to discover it."
if($entry){
    @{mcpServers=@{'desktop-pilot'=$server}}|ConvertTo-Json -Depth 5
}
else {Write-Output 'No launcher found. Build the windows-release native worker and Node entry, or install a release; the skill alone cannot operate the desktop.'}
