param([Parameter(Mandatory=$true)][string]$Executable,
 [Parameter(Mandatory=$true)][string]$TargetTitle,
 [Parameter(Mandatory=$true)][string]$FieldName,
 [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'client.ps1')
$client=$null
try {
 $client=Open-Pilot $Executable
 $connection=$client.Initialization._meta.'desktopPilot/desktopPreflight'
 if(-not $connection.ready){throw ($connection|ConvertTo-Json -Depth 20 -Compress)}
 $selection=Call-Pilot $client 'list_windows' @{}
 $selection.windows=@($selection.windows | Where-Object { $_.title.Contains($TargetTitle) })
 if($selection.status -ne 'ok' -or @($selection.windows).Count -ne 1){throw 'Window is not unique; narrow TargetTitle. No input sent.'}
 $window_id=$selection.windows[0].window_id
 $state=Call-Pilot $client 'get_window_state' @{window_id=$window_id;mode='controls'}
 $edits=@($state.controls|Where-Object {$_.role -eq 'Edit' -and $_.name -ceq $FieldName})
 if($state.truncated -or $edits.Count -ne 1){throw 'Need one observed Edit with the exact FieldName and a complete observation; no text input sent.'}
 $result=Call-Pilot $client 'execute_batch' @{window_id=$window_id;actions=@(@{type='fill_text';control_id=$edits[0].control_id;text=$Text})}
 $after=Call-Pilot $client 'get_window_state' @{window_id=$window_id;mode='controls'}
 $matches=@($after.controls|Where-Object {$_.role -eq 'Edit' -and $_.name -ceq $FieldName -and $_.value -ceq $Text})
 if($after.truncated -or $matches.Count -ne 1){throw 'Final field value not confirmed. Inspect before retrying; no submit was clicked.'}
 @{status='field_verified';fieldsVerified=$result.fieldsVerified;submitted=$false}|ConvertTo-Json
} finally {Close-Pilot $client}
