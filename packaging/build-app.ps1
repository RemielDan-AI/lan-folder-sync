# Build the portable Windows app folder (and a zip of it).
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM.
#
#   powershell -ExecutionPolicy Bypass -File packaging\build-app.ps1

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$distRoot = Join-Path $repo 'dist'
$name = 'Communication-win-x64'
$target = Join-Path $distRoot $name
$appDir = Join-Path $target 'app'

Write-Host "Repo  : $repo"
Write-Host "Target: $target"

# 1. clean
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# 2. copy the app itself
$files = @('server.js', 'package.json', 'README.md', 'start.sh')
foreach ($file in $files) {
    $src = Join-Path $repo $file
    if (Test-Path $src) { Copy-Item $src (Join-Path $appDir $file) }
}
foreach ($dir in @('lib', 'shared', 'public')) {
    $src = Join-Path $repo $dir
    if (-not (Test-Path $src)) { throw "missing directory: $dir" }
    Copy-Item $src (Join-Path $appDir $dir) -Recurse
}
Write-Host 'app files copied'

# 3. bundle node.exe so the app does not need Node installed
$nodeExe = (Get-Command node -ErrorAction Stop).Source
Copy-Item $nodeExe (Join-Path $target 'node.exe')
$nodeSize = [math]::Round((Get-Item (Join-Path $target 'node.exe')).Length / 1MB, 1)
Write-Host "node.exe bundled ($nodeSize MB)"

# 4. icon (best effort: a missing icon only means the default exe icon)
$ico = Join-Path $distRoot 'app.ico'
$iconArgs = @()
try {
    Add-Type -AssemblyName System.Drawing
    $size = 64
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(34, 197, 94))
    $g.FillEllipse($bg, 0, 0, $size - 1, $size - 1)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 6
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    # two arrows: a rough sync glyph
    $g.DrawArc($pen, 14, 14, 36, 36, 30, 150)
    $g.DrawArc($pen, 14, 14, 36, 36, 210, 150)
    $g.DrawLine($pen, 42, 10, 46, 22)
    $g.DrawLine($pen, 22, 54, 18, 42)
    $g.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $stream = [System.IO.File]::Create($ico)
    $icon.Save($stream)
    $stream.Close()
    $iconArgs = @("/win32icon:$ico")
    Write-Host 'icon generated'
} catch {
    Write-Host "icon skipped: $($_.Exception.Message)"
}

# 5. compile the launcher with the C# compiler that ships with Windows
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe not found (.NET Framework 4 required)' }

$exe = Join-Path $target 'Communication.exe'
$source = Join-Path $repo 'packaging\launcher.cs'
$args = @(
    '/nologo',
    '/target:winexe',
    '/codepage:65001',
    '/optimize+',
    "/out:$exe",
    '/r:System.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll'
) + $iconArgs + @($source)

& $csc $args
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
if (-not (Test-Path $exe)) { throw 'launcher exe was not produced' }
$exeSize = [math]::Round((Get-Item $exe).Length / 1KB, 1)
Write-Host "launcher built ($exeSize KB)"

# 6. usage notes (UTF-8 with BOM so Notepad shows Chinese correctly)
# The file name itself is built from code points: this script must stay ASCII-only,
# otherwise Windows PowerShell 5.1 reads it as ANSI and the name becomes mojibake.
$noteSrc = Join-Path $repo 'packaging\readme-portable.txt'
$noteText = [System.IO.File]::ReadAllText($noteSrc, [System.Text.Encoding]::UTF8)
$noteName = (-join [char[]](0x4F7F, 0x7528, 0x8BF4, 0x660E)) + '.txt'
[System.IO.File]::WriteAllText(
    (Join-Path $target $noteName),
    $noteText,
    (New-Object System.Text.UTF8Encoding($true))
)
New-Item -ItemType Directory -Force -Path (Join-Path $target 'data') | Out-Null

# 7. zip
$zip = Join-Path $distRoot "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $target -DestinationPath $zip -CompressionLevel Optimal
$zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 1)

Write-Host ''
Write-Host 'DONE'
Write-Host "  folder: $target"
Write-Host "  zip   : $zip ($zipSize MB)"
