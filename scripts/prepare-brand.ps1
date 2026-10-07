param([string]$Source = (Join-Path $PSScriptRoot '../public/agentdeck-logo.jpg'))
Add-Type -AssemblyName System.Drawing
$brandSource = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source))
try {
    # Fit the supplied mark to app-icon sizes without changing its artwork.
    $brandOutput = New-Object System.Drawing.Bitmap 1024, 1024
    $brandGraphics = [System.Drawing.Graphics]::FromImage($brandOutput)
    try {
        $brandGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $brandCrop = New-Object System.Drawing.Rectangle 315, 275, 635, 635
        $brandTarget = New-Object System.Drawing.Rectangle 0, 0, 1024, 1024
        $brandGraphics.DrawImage($brandSource, $brandTarget, $brandCrop, [System.Drawing.GraphicsUnit]::Pixel)
        $brandOutput.Save((Join-Path $PSScriptRoot '../public/agentdeck-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $brandGraphics.Dispose(); $brandOutput.Dispose() }
} finally { $brandSource.Dispose() }
