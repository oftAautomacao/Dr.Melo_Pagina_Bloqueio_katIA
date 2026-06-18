Add-Type -AssemblyName System.Drawing

$srcPath  = 'C:\Users\Master\.gemini\antigravity-ide\brain\d6e35b3a-ae8c-44f7-b749-50d3b1998eb0\extension_icon_1781788637474.png'
$iconsDir = 'c:\Users\Master\OneDrive\Documentos\OFT\Antigravity\AbaCancelar_DrMelo\icons'

New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

$src = [System.Drawing.Image]::FromFile($srcPath)

foreach ($size in @(16, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    $outPath = Join-Path $iconsDir ("icon" + $size + ".png")
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Criado: $outPath"
}

$src.Dispose()
Write-Host "Icones criados com sucesso!"
