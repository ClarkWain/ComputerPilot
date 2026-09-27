param(
    [string]$OutputDir = 'out/dist/DesktopPilot-Node',
    [string]$NativeExe = 'build/release/Release/desktop-pilot-native.exe',
    [string]$WebpLicenseDir = '',
    [string]$DetectorOnnx = 'build/node-vision-validation/omniparser-dynamic.onnx',
    [string]$NodeArchive = '.deps/downloads/node-v22.15.0-win-x64.zip'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeVersion = '22.15.0'
$nodeZipSha256 = '06067d4f0d463f90ed803d5eca5b039a05dec5d70fc7b7cc254803a59bd0e27c'

function Resolve-InputPath([string]$value) {
    if ([IO.Path]::IsPathRooted($value)) { return [IO.Path]::GetFullPath($value) }
    return [IO.Path]::GetFullPath((Join-Path $repoRoot $value))
}
function Require-File([string]$path) {
    if (-not [IO.File]::Exists($path)) { throw "Required release input is missing: $path" }
}
function Assert-File([string]$path, [long]$bytes, [string]$sha256) {
    Require-File $path
    $item = Get-Item -LiteralPath $path
    if ($item.Length -ne $bytes) { throw "Unexpected file size: $path" }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $sha256.ToLowerInvariant()) { throw "SHA-256 mismatch: $path" }
}
function Invoke-Checked([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $exe $($arguments -join ' ')" }
}
function Assert-ChildPath([string]$candidate, [string]$root) {
    $full = [IO.Path]::GetFullPath($candidate)
    $base = [IO.Path]::GetFullPath($root).TrimEnd('\')
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the intended directory: $full"
    }
    return $full
}

$output = Resolve-InputPath $OutputDir
$native = Resolve-InputPath $NativeExe
$webpDir = if ($WebpLicenseDir) { Resolve-InputPath $WebpLicenseDir } else {
    Join-Path (Split-Path -Parent (Split-Path -Parent $native)) 'licenses/webp'
}
$detector = Resolve-InputPath $DetectorOnnx
$archive = Resolve-InputPath $NodeArchive
$ocrManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'models/manifest.json') -Raw | ConvertFrom-Json
$detectorManifestPath = "$detector.manifest.json"
Require-File $native
Require-File (Join-Path $webpDir 'COPYING')
Require-File (Join-Path $webpDir 'PATENTS')
Require-File $detectorManifestPath
$detectorManifest = Get-Content -LiteralPath $detectorManifestPath -Raw | ConvertFrom-Json
if ($detectorManifest.schemaVersion -ne 1 -or
    $detectorManifest.sourceSha256 -ne $ocrManifest.detector.sha256 -or
    $detectorManifest.contract -ne $ocrManifest.detector.contract -or
    $detectorManifest.opset -ne 17) {
    throw "OmniParser conversion manifest does not match the supported source model: $detectorManifestPath"
}
Assert-File $detector ([long]$detectorManifest.onnxBytes) ([string]$detectorManifest.onnxSha256)
$ocrDet = Join-Path $repoRoot 'models/ocr/det.onnx'
$ocrRec = Join-Path $repoRoot 'models/ocr/rec.onnx'
Assert-File $ocrDet ([long]$ocrManifest.ocr.det.bytes) ([string]$ocrManifest.ocr.det.sha256)
Assert-File $ocrRec ([long]$ocrManifest.ocr.rec.bytes) ([string]$ocrManifest.ocr.rec.sha256)
foreach ($path in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'node/package.json',
        'node/package-lock.json', 'node/README.md', 'third_party/rapidocr/LICENSE',
        'third_party/nlohmann/LICENSE.MIT',
        'scripts/smoke-node-bundle.mjs')) {
    Require-File (Join-Path $repoRoot $path)
}
if ([IO.Directory]::Exists($output) -or [IO.File]::Exists($output)) {
    throw "Package destination already exists; choose a fresh OutputDir: $output"
}

if (-not [IO.File]::Exists($archive)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $archive) -Force | Out-Null
    $uri = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
    Write-Host "Downloading pinned Node.js $nodeVersion from $uri"
    Invoke-WebRequest -Uri $uri -UseBasicParsing -OutFile $archive
}
$archiveSha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($archiveSha -ne $nodeZipSha256) { throw "Pinned Node archive SHA-256 mismatch: $archive" }
$ortLicense = Join-Path $repoRoot '.deps/downloads/onnxruntime-1.30.0-LICENSE'
$ortNotices = Join-Path $repoRoot '.deps/downloads/onnxruntime-1.30.0-ThirdPartyNotices.txt'
if (-not [IO.File]::Exists($ortLicense)) {
    Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/LICENSE' -UseBasicParsing -OutFile $ortLicense
}
if (-not [IO.File]::Exists($ortNotices)) {
    Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt' -UseBasicParsing -OutFile $ortNotices
}
Assert-File $ortLicense 1073 '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'
Assert-File $ortNotices 338088 '143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3'

$parent = Split-Path -Parent $output
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$stage = Assert-ChildPath (Join-Path $parent ('.DesktopPilot-Node-staging-' + [Guid]::NewGuid().ToString('N'))) $parent
if ([IO.Path]::GetDirectoryName($stage) -ne [IO.Path]::GetFullPath($parent).TrimEnd('\')) {
    throw 'Unsafe staging path'
}
New-Item -ItemType Directory -Path $stage | Out-Null
$published = $false
try {
    $unpack = Assert-ChildPath (Join-Path $stage '.node-unpack') $stage
    Expand-Archive -LiteralPath $archive -DestinationPath $unpack
    $runtimeSource = Join-Path $unpack "node-v$nodeVersion-win-x64"
    $runtimeNode = Join-Path $runtimeSource 'node.exe'
    $npmCli = Join-Path $runtimeSource 'node_modules/npm/bin/npm-cli.js'
    Require-File $runtimeNode
    Require-File $npmCli
    Require-File (Join-Path $runtimeSource 'LICENSE')
    $reportedVersion = (& $runtimeNode --version)
    if ($reportedVersion -ne "v$nodeVersion") { throw "Unexpected Node runtime: $reportedVersion" }

    # Build in an isolated directory so active development processes never lock npm ci's files.
    $sourceNode = Join-Path $repoRoot 'node'
    $buildNode = Assert-ChildPath (Join-Path $stage '.build-node') $stage
    New-Item -ItemType Directory -Path $buildNode | Out-Null
    foreach ($file in @('package.json', 'package-lock.json', 'tsconfig.json')) {
        Copy-Item -LiteralPath (Join-Path $sourceNode $file) -Destination (Join-Path $buildNode $file)
    }
    Copy-Item -LiteralPath (Join-Path $sourceNode 'src') -Destination (Join-Path $buildNode 'src') -Recurse
    Copy-Item -LiteralPath (Join-Path $sourceNode 'tests') -Destination (Join-Path $buildNode 'tests') -Recurse
    Invoke-Checked $runtimeNode @($npmCli, 'ci', '--prefix', $buildNode, '--no-audit', '--no-fund')
    Invoke-Checked $runtimeNode @($npmCli, 'run', 'build', '--prefix', $buildNode)
    $distEntry = Join-Path $buildNode 'dist/src/index.js'
    Require-File $distEntry

    New-Item -ItemType Directory -Path (Join-Path $stage 'runtime'),
        (Join-Path $stage 'node/dist'), (Join-Path $stage 'native'),
        (Join-Path $stage 'models/ocr'), (Join-Path $stage 'models/icon_detect_v3'),
        (Join-Path $stage 'licenses/nodejs'), (Join-Path $stage 'licenses/rapidocr'),
        (Join-Path $stage 'licenses/nlohmann'), (Join-Path $stage 'licenses/webp'),
        (Join-Path $stage 'licenses/onnxruntime-1.30.0') | Out-Null
    Copy-Item -LiteralPath $runtimeNode -Destination (Join-Path $stage 'runtime/node.exe')
    Copy-Item -LiteralPath (Join-Path $runtimeSource 'LICENSE') -Destination (Join-Path $stage 'licenses/nodejs/LICENSE')
    Copy-Item -LiteralPath (Join-Path $sourceNode 'package.json') -Destination (Join-Path $stage 'node/package.json')
    Copy-Item -LiteralPath (Join-Path $sourceNode 'package-lock.json') -Destination (Join-Path $stage 'node/package-lock.json')
    Copy-Item -LiteralPath (Join-Path $buildNode 'dist/src') -Destination (Join-Path $stage 'node/dist/src') -Recurse
    Invoke-Checked $runtimeNode @($npmCli, 'ci', '--omit=dev', '--prefix', (Join-Path $stage 'node'), '--no-audit', '--no-fund')
    Copy-Item -LiteralPath $native -Destination (Join-Path $stage 'native/desktop-pilot-native.exe')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'profiles') -Destination (Join-Path $stage 'profiles') -Recurse
    Copy-Item -LiteralPath $ocrDet -Destination (Join-Path $stage 'models/ocr/det.onnx')
    Copy-Item -LiteralPath $ocrRec -Destination (Join-Path $stage 'models/ocr/rec.onnx')
    Copy-Item -LiteralPath $detector -Destination (Join-Path $stage 'models/icon_detect_v3/model.onnx')
    Copy-Item -LiteralPath $detectorManifestPath -Destination (Join-Path $stage 'models/icon_detect_v3/model.onnx.manifest.json')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'models/manifest.json') -Destination (Join-Path $stage 'models/manifest.json')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $stage 'LICENSE')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $stage 'THIRD_PARTY_NOTICES.md')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'third_party/rapidocr/LICENSE') -Destination (Join-Path $stage 'licenses/rapidocr/LICENSE')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'third_party/nlohmann/LICENSE.MIT') -Destination (Join-Path $stage 'licenses/nlohmann/LICENSE.MIT')
    Copy-Item -LiteralPath (Join-Path $webpDir 'COPYING') -Destination (Join-Path $stage 'licenses/webp/COPYING')
    Copy-Item -LiteralPath (Join-Path $webpDir 'PATENTS') -Destination (Join-Path $stage 'licenses/webp/PATENTS')
    Copy-Item -LiteralPath $ortLicense -Destination (Join-Path $stage 'licenses/onnxruntime-1.30.0/LICENSE')
    Copy-Item -LiteralPath $ortNotices -Destination (Join-Path $stage 'licenses/onnxruntime-1.30.0/ThirdPartyNotices.txt')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'node/README.md') -Destination (Join-Path $stage 'README.md')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/guides/REPLAY.md') -Destination (Join-Path $stage 'REPLAY.md')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/guides/ORCHESTRATION.md') -Destination (Join-Path $stage 'ORCHESTRATION.md')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/smoke-node-bundle.mjs') -Destination (Join-Path $stage 'smoke.mjs')
    [IO.File]::WriteAllText((Join-Path $stage 'desktop-pilot-mcp.cmd'),
        "@echo off`r`n`"%~dp0runtime\node.exe`" `"%~dp0node\dist\src\index.js`"`r`n")
    [IO.File]::WriteAllText((Join-Path $stage 'desktop-pilot-replay.cmd'),
        "@echo off`r`n`"%~dp0runtime\node.exe`" `"%~dp0node\dist\src\replay\cli.js`" %*`r`n")
    [IO.File]::WriteAllText((Join-Path $stage 'desktop-pilot-orchestration.cmd'),
        "@echo off`r`n`"%~dp0runtime\node.exe`" `"%~dp0node\dist\src\orchestration\cli.js`" %*`r`n")
    $mcpExample = @{ mcpServers = @{ 'desktop-pilot' = @{
        command = 'C:/tools/DesktopPilot-Node/runtime/node.exe';
        args = @('C:/tools/DesktopPilot-Node/node/dist/src/index.js')
    } } } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $stage 'mcp.example.json'), $mcpExample + "`n")

    # Build intermediates are removed before the file-level integrity manifest is written.
    Remove-Item -LiteralPath (Assert-ChildPath $unpack $stage) -Recurse -Force
    Remove-Item -LiteralPath (Assert-ChildPath $buildNode $stage) -Recurse -Force
    $files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
        @{ path = $_.FullName.Substring($stage.Length + 1).Replace('\', '/'); bytes = $_.Length;
           sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    $bundleManifest = @{
        schemaVersion = 1; platform = 'win32-x64'; nodeVersion = $nodeVersion;
        nodeArchiveSha256 = $nodeZipSha256; files = $files
    } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $stage 'bundle-manifest.json'), $bundleManifest + "`n")

    Invoke-Checked (Join-Path $stage 'runtime/node.exe') @((Join-Path $stage 'smoke.mjs'), $stage)
    $stage = Assert-ChildPath $stage $parent
    if ([IO.Directory]::Exists($output) -or [IO.File]::Exists($output)) {
        throw "Package destination appeared during build: $output"
    }
    Move-Item -LiteralPath $stage -Destination $output
    $published = $true
    Write-Host "Portable DesktopPilot Node bundle: $output"
} finally {
    if (-not $published -and [IO.Directory]::Exists($stage)) {
        $stage = Assert-ChildPath $stage $parent
        if ([IO.Path]::GetDirectoryName($stage) -ne [IO.Path]::GetFullPath($parent).TrimEnd('\')) {
            throw "Unsafe staging cleanup path: $stage"
        }
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
