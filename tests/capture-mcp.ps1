param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][int]$TargetPid,[string]$OutputDirectory='out/capture-mcp')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/../examples/onboarding/client.ps1"
[void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory))
$previous=$env:DP_IMAGE_FORMAT
try {
 foreach($format in @('webp','png')) {
  $env:DP_IMAGE_FORMAT=$format
  $client=Open-Pilot $Executable
  try {
   if(-not $client.Initialization._meta.'desktopPilot/desktopPreflight'.ready){throw 'Desktop not ready'}
   $windows=Call-Pilot $client 'list_windows' @{}
   $target=@($windows.windows|Where-Object pid -eq $TargetPid)
   if($target.Count -ne 1){throw 'Test window must be unique'}
   foreach($crop in @($false,$true)) {
    $arguments=@{window_id=$target[0].window_id;mode='image'}
    if($crop){$arguments.region=@{x=30;y=260;width=600;height=500}}
    $response=Send-Pilot $client 'tools/call' @{name='get_window_state';arguments=$arguments}
    if($response.isError){throw ($response.structuredContent|ConvertTo-Json -Depth 8 -Compress)}
    $state=$response.structuredContent
    $image=@($response.content|Where-Object type -eq 'image')
    if($image.Count -ne 1 -or $image[0].mimeType -ne "image/$format"){throw 'Incorrect MCP image MIME'}
    if([Math]::Max($state.capture.width,$state.capture.height) -gt 1600){throw 'Screenshot cap exceeded'}
    if($state.coordinateSpace -ne 'image_pixels'){throw 'Screenshot mapping missing'}
    $bytes=[Convert]::FromBase64String($image[0].data)
    $name="$format-$crop"
    [IO.File]::WriteAllBytes([IO.Path]::GetFullPath("$OutputDirectory/$name.$format"),$bytes)
    @{format=$format;cropped=$crop;width=$state.capture.width;height=$state.capture.height;bytes=$bytes.Length;originalPath=$state.capture.originalPath;coordinateSpace=$state.coordinateSpace}|ConvertTo-Json -Compress
   }
  } finally {Close-Pilot $client}
 }
} finally {$env:DP_IMAGE_FORMAT=$previous}
