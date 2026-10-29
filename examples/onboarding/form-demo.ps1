param([Parameter(Mandatory=$true)][string]$Executable,[switch]$TestFocusRecovery)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'client.ps1')
$client=$null;$fixture=$null;$distractor=$null;$timer=[Diagnostics.Stopwatch]::StartNew()
try {
    $client=Open-Pilot $Executable
    $connection=$client.Initialization._meta.'desktopPilot/desktopPreflight'
    if(-not $connection.ready){throw ($connection|ConvertTo-Json -Depth 20 -Compress)}
    $exe=Join-Path (Split-Path (Resolve-Path $Executable)) 'computer-pilot-onboarding.exe'
    $fixture=Start-Process -FilePath $exe -WindowStyle Hidden -PassThru
    [void]$fixture.WaitForInputIdle(5000)
    $selected=Call-Pilot $client 'list_windows' @{}
    $selected.windows=@($selected.windows | Where-Object { $_.pid -eq $fixture.Id })
    if($selected.status -ne 'ok' -or @($selected.windows).Count -ne 1){throw 'Expected exactly one fixture window; no input sent.'}
    $window_id=$selected.windows[0].window_id
    $state=Call-Pilot $client 'get_window_state' @{window_id=$window_id;mode='controls'}
    $edit=@($state.controls|Where-Object role -eq 'Edit')
    $apply=@($state.controls|Where-Object { $_.name -eq 'Apply' -and $_.role -eq 'Button' })
    if($state.truncated -or $edit.Count -ne 1 -or $apply.Count -ne 1){throw 'Expected one edit and one Apply button; no form input sent.'}
    if($TestFocusRecovery) {
        # Create another disposable window and deliberately move focus away.
        $distractor=Start-Process -FilePath $exe -WindowStyle Hidden -PassThru
        [void]$distractor.WaitForInputIdle(5000)
        $other=Call-Pilot $client 'list_windows' @{}
    $other.windows=@($other.windows | Where-Object { $_.pid -eq $distractor.Id })
        if(@($other.windows).Count -ne 1){throw 'Expected one distractor window.'}
        $null=Call-Pilot $client 'get_window_state' @{window_id=$other.windows[0].window_id;mode='controls'}
        $before=Call-Pilot $client 'get_window_state' @{window_id=$window_id;mode='controls';activate=$false}
        $edit=@($before.controls|Where-Object role -eq 'Edit')
        $apply=@($before.controls|Where-Object name -eq 'Apply')
        if($before.foreground){throw 'Test did not actually remove target focus.'}
    }
    $result=Call-Pilot $client 'execute_batch' @{window_id=$window_id;actions=@(
        @{type='fill_text';control_id=$edit[0].control_id;text='Hello ComputerPilot'},
        @{type='click';control_id=$apply[0].control_id}
    )}
    # The consumed observation is internal; replay without inspecting is rejected.
    $stale=Send-Pilot $client 'tools/call' @{name='execute_batch';arguments=@{window_id=$window_id;actions=@(@{type='click';control_id=$apply[0].control_id})}}
    if(-not $stale.isError -or $stale.structuredContent.code -ne 'state_required'){throw 'Consumed observation was not rejected.'}
    $until=[DateTime]::UtcNow.AddSeconds(3)
    do {
        $after=Call-Pilot $client 'get_window_state' @{window_id=$window_id;mode='controls'}
        $matched=@($after.controls|Where-Object name -eq 'Applied: Hello ComputerPilot').Count -eq 1
        if(-not $matched){Start-Sleep -Milliseconds 100}
    } while(-not $matched -and [DateTime]::UtcNow -lt $until)
    if(-not $matched){throw 'Input dispatched but application result was not verified. Do not resubmit blindly.'}
    @{status='passed';fieldsVerified=$result.fieldsVerified;applicationResult='Applied: Hello ComputerPilot';
      staleObservationRejected=$true;focusRecoveryTested=[bool]$TestFocusRecovery;elapsedMs=$timer.ElapsedMilliseconds}|ConvertTo-Json
} finally {
    if($distractor){if(-not $distractor.HasExited){[void]$distractor.CloseMainWindow();if(-not $distractor.WaitForExit(2000)){$distractor.Kill()}};$distractor.Dispose()}
    if($fixture){if(-not $fixture.HasExited){[void]$fixture.CloseMainWindow();if(-not $fixture.WaitForExit(2000)){$fixture.Kill()}};$fixture.Dispose()}
    Close-Pilot $client
}
