# Android SDK 一键安装（无需 Android Studio）
# 用法：powershell -ExecutionPolicy Bypass -File install-sdk.ps1
# 幂等：已装过的组件会跳过。装到 %LOCALAPPDATA%\Android\Sdk（Android Studio 默认位置）。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# 控制台按 UTF-8 输出，避免中文变乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$sdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$cmdlineRoot = Join-Path $sdkRoot 'cmdline-tools'
$latest = Join-Path $cmdlineRoot 'latest'
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'

# AGP 8.x 需要的组件：adb、一个 platform、一个 build-tools
$packages = @('platform-tools', 'platforms;android-35', 'build-tools;35.0.0')

# 官方 cmdline-tools 包（新版本优先，逐个尝试；不想解析仓库 XML，那玩意带命名空间不稳）
$zipCandidates = @(
  'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-10406996_latest.zip'
)

Write-Host "SDK 根目录: $sdkRoot"
New-Item -ItemType Directory -Force -Path $sdkRoot | Out-Null

if (-not (Test-Path (Join-Path $latest 'bin\sdkmanager.bat'))) {
  $zip = Join-Path $env:TEMP 'android-cmdline-tools.zip'
  $downloaded = $false
  foreach ($url in $zipCandidates) {
    try {
      Write-Host "下载: $url"
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
      Write-Host ("下载完成: {0:N1} MB" -f ((Get-Item $zip).Length / 1MB))
      $downloaded = $true
      break
    } catch {
      Write-Host "  这个地址不行，换下一个：$($_.Exception.Message)"
    }
  }
  if (-not $downloaded) { throw 'cmdline-tools 下载全部失败，检查网络' }

  $tmp = Join-Path $env:TEMP 'android-cmdline-unzip'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Write-Host '解压 ...'
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path $cmdlineRoot | Out-Null
  if (Test-Path $latest) { Remove-Item -Recurse -Force $latest }
  Move-Item (Join-Path $tmp 'cmdline-tools') $latest
  Remove-Item -Recurse -Force $tmp
  Remove-Item $zip -Force
  Write-Host 'cmdline-tools 就绪'
}

$sdkmanager = Join-Path $latest 'bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) { throw "sdkmanager 缺失: $sdkmanager" }

Write-Host '接受许可协议 ...'
1..40 | ForEach-Object { 'y' } | & $sdkmanager "--sdk_root=$sdkRoot" --licenses 2>&1 | Out-Null

Write-Host "安装组件: $($packages -join ', ')"
& $sdkmanager "--sdk_root=$sdkRoot" @packages

Write-Host ''
Write-Host '=== 安装结果 ==='
$adb = Join-Path $sdkRoot 'platform-tools\adb.exe'
if (Test-Path $adb) { & $adb version | Select-Object -First 1 }
Write-Host 'platforms:'
Get-ChildItem (Join-Path $sdkRoot 'platforms') -Directory -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.Name)" }
Write-Host 'build-tools:'
Get-ChildItem (Join-Path $sdkRoot 'build-tools') -Directory -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.Name)" }

Write-Host ''
Write-Host '记下这个路径，构建脚本会用到：'
Write-Host "  ANDROID_HOME=$sdkRoot"
