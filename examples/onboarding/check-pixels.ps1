param([string]$ImagePath)
$ErrorActionPreference='Stop'
if(-not $ImagePath){$ImagePath="E:\My_Project\DesktopPilot\out\blue-rect\blue-rect-result.png"}
if(-not (Test-Path -LiteralPath $ImagePath)){throw "File not found: $ImagePath"}
Add-Type -AssemblyName System.Drawing
$bitmap=[Drawing.Bitmap]::new($ImagePath)
$w=$bitmap.Width; $h=$bitmap.Height
Write-Host "Image size: ${w}x${h}"

# Check the area where we drew: (100,200)-(300,400)
$nonWhite=0; $blue=0; $total=0
$bluePixels=@()
for($y=150;$y -lt 450;$y+=5){
    for($x=50;$x -lt 350;$x+=5){
        if($x -ge $w -or $y -ge $h){continue}
        $total++
        $px=$bitmap.GetPixel($x,$y)
        if($px.R -ne 255 -or $px.G -ne 255 -or $px.B -ne 255){
            $nonWhite++
            if($px.B -gt 100 -and $px.R -lt 150 -and $px.G -lt 150){
                $blue++
                if($bluePixels.Count -lt 10){$bluePixels+= "($x,$y) R=$($px.R) G=$($px.G) B=$($px.B)"}
            }
        }
    }
}
Write-Host "Sampled $total pixels in (50,150)-(350,450)"
Write-Host "Non-white: $nonWhite"
Write-Host "Blue-ish: $blue"
if($bluePixels.Count -gt 0){
    Write-Host "Sample blue pixels:"
    foreach($p in $bluePixels){Write-Host "  $p"}
}

# Check center of expected rectangle
$cx=200; $cy=300
if($cx -lt $w -and $cy -lt $h){
    $centerPx=$bitmap.GetPixel($cx,$cy)
    Write-Host "Center (200,300): R=$($centerPx.R) G=$($centerPx.G) B=$($centerPx.B)"
}

# Check corners of expected rectangle
foreach($pt in @(@(100,200),@(300,200),@(100,400),@(300,400))){
    if($pt[0] -lt $w -and $pt[1] -lt $h){
        $px=$bitmap.GetPixel($pt[0],$pt[1])
        Write-Host "Corner ($($pt[0]),$($pt[1])): R=$($px.R) G=$($px.G) B=$($px.B)"
    }
}
$bitmap.Dispose()
