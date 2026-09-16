param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'client.ps1')
$client=$null
try {
    $client=Open-Pilot $Executable
    $preflight=$client.Initialization._meta.'desktopPilot/desktopPreflight'
    if(-not $preflight.ready){$preflight|ConvertTo-Json -Depth 20;exit 3}
    $windows=Call-Pilot $client 'list_windows' @{}
    @{status='ready';windowCount=@($windows.windows).Count;
      next='Use the intended windows[].window_id directly with get_window_state.'}|ConvertTo-Json
} finally {Close-Pilot $client}
