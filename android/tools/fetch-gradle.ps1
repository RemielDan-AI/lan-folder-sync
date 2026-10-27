# Fetch the Gradle distribution used by build-apk.bat.
# github.com is unreachable on this machine, so we use the Tencent mirror.
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$zip = Join-Path $env:TEMP 'gradle-8.9-bin.zip'
$target = Join-Path $tools 'gradle-8.9\bin\gradle.bat'

if (Test-Path $target) {
    Write-Host 'Gradle already present.'
    exit 0
}

$mirrors = @(
    'https://mirrors.cloud.tencent.com/gradle/gradle-8.9-bin.zip',
    'https://mirrors.huaweicloud.com/gradle/gradle-8.9-bin.zip'
)

foreach ($url in $mirrors) {
    try {
        Write-Host "Downloading $url"
        & curl.exe -L --retry 3 --connect-timeout 20 -o $zip $url
        if ((Test-Path $zip) -and (Get-Item $zip).Length -gt 50MB) { break }
    } catch {
        Write-Host "  failed: $($_.Exception.Message)"
    }
}

if (-not (Test-Path $zip)) { throw 'Could not download Gradle from any mirror' }

Expand-Archive -Path $zip -DestinationPath $tools -Force
Remove-Item $zip -Force
Write-Host "Gradle ready: $target"
