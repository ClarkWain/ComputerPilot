param([ValidateSet('check','form','draw')][string]$Task='check',[string]$Executable)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(-not $Executable){
    $Executable=@((Join-Path $root 'bin/computer-pilot.exe'),(Join-Path $root 'build/core/Release/computer-pilot.exe'))|
        Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
}
if(-not $Executable -or -not (Test-Path -LiteralPath $Executable)){throw 'ComputerPilot executable missing. Build core or unpack a release, or pass -Executable with the actual path.'}
$script=if($Task -eq 'check'){'smoke.ps1'}elseif($Task -eq 'form'){'form-demo.ps1'}else{'draw-demo.ps1'}
& (Join-Path $PSScriptRoot $script) -Executable $Executable
