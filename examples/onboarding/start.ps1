param([ValidateSet('check','form','draw')][string]$Task='check',[string]$Executable)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(-not $Executable){
    $Executable=@((Join-Path $root 'node/dist/src/index.js'),
        (Join-Path $root 'out/dist/DesktopPilot-Node/desktop-pilot-mcp.cmd'),
        (Join-Path $root 'desktop-pilot-mcp.cmd'),(Join-Path $root 'bin/desktop-pilot.exe'))|
        Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
}
if(-not $Executable -or -not (Test-Path -LiteralPath $Executable)){throw 'DesktopPilot launcher missing. Build the windows-release native worker and Node entry, unpack a release, or pass -Executable with the actual path.'}
$script=if($Task -eq 'check'){'smoke.ps1'}elseif($Task -eq 'form'){'form-demo.ps1'}else{'draw-demo.ps1'}
$LASTEXITCODE=0
& (Join-Path $PSScriptRoot $script) -Executable $Executable
if($LASTEXITCODE){exit $LASTEXITCODE}
