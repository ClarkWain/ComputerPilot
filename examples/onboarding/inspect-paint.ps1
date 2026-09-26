param([string]$Executable)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(-not $Executable){
    $Executable=@((Join-Path $root 'bin/desktop-pilot.exe'),(Join-Path $root 'build/core/Release/desktop-pilot.exe'))|
        Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
}
. (Join-Path $PSScriptRoot 'client.ps1')
$client=$null
try {
    $client=Open-Pilot $Executable
    $windows=Call-Pilot $client 'list_windows' @{}
    $paintWindow=$null
    foreach($w in $windows.windows){
        if($w.title -match '画图|Paint'){$paintWindow=$w;break}
    }
    if(-not $paintWindow){throw 'No MSPaint window found.'}
    $ref=$paintWindow.window_id
    Write-Host "Window: $ref | $($paintWindow.title)"

    $state=Call-Pilot $client 'get_window_state' @{window_id=$ref;mode='controls'}
    # Show all controls with their properties
    Write-Host "Total controls: $($state.controls.Count)"
    Write-Host "Truncated: $($state.truncated)"
    Write-Host ''
    Write-Host 'All controls (name, role, bounds, automationId):'
    foreach($c in $state.controls){
        $bounds=$c.bounds
        $bStr=''
        if($bounds){$bStr="x=$($bounds.x),y=$($bounds.y),w=$($bounds.width),h=$($bounds.height)"}
        $autoId=$c.automationId
        if($autoId){$autoId=" autoId=$autoId"}
        Write-Host "  [$($c.role)] '$($c.name)' $bStr$autoId"
    }
} finally {
    Close-Pilot $client
}
