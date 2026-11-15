# 一键打包发布：生成 zip + SHA256 + 发布说明
#
#   pwsh -File scripts/release.ps1 -Version 0.1.0
#
# 产物在 dist\ 下：
#   VoiceKeys-<ver>-win-x64.zip
#   VoiceKeys-<ver>-win-x64.zip.sha256
#   release-notes-<ver>.md
param(
  [string]$Version = "0.0.0-dev",
  [switch]$SkipNative
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$name = "VoiceKeys-$Version-win-x64"
$stage = Join-Path $dist $name
$zip = Join-Path $dist "$name.zip"

Write-Host "[1/5] 清理 dist"
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Write-Host "[2/5] 复制程序文件"
$include = @('app', 'src', 'runtime', 'custom', 'test', 'docs',
             'README.md', 'LICENSE', 'NOTICE', 'BUILDING.md', 'CHANGELOG.md',
             'package.json', 'pnpm-lock.yaml', 'plans.json', 'start.cmd')
foreach ($item in $include) {
  $p = Join-Path $root $item
  if (Test-Path $p) {
    Copy-Item $p -Destination $stage -Recurse -Force
  }
}

Write-Host "[3/5] 复制原生模块（sherpa-onnx / pvrecorder / transcribe-cpp / koffi）"
if (-not $SkipNative) {
  $nm = Join-Path $root 'node_modules'
  if (Test-Path $nm) {
    $nativeDirs = @('sherpa-onnx-node', 'sherpa-onnx-win-x64', 'sherpa-onnx-win-x64-cpu',
                    '@picovoice', 'transcribe-cpp', '@transcribe-cpp', 'koffi')
    $dest = Join-Path $stage 'node_modules'
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    foreach ($d in $nativeDirs) {
      $src = Join-Path $nm $d
      if (Test-Path $src) {
        $target = Join-Path $dest $d
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item $src -Destination $target -Recurse -Force
        Write-Host "      + $d"
      }
    }
  }
}

Write-Host "[4/5] 写版本信息"
$ver = @{ version = $Version; builtAt = (Get-Date).ToString('s') } | ConvertTo-Json
Set-Content -Path (Join-Path $stage 'version.json') -Value $ver -Encoding UTF8

Write-Host "[5/5] 打包 + 校验"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $name.zip" | Set-Content -Path "$zip.sha256" -Encoding ASCII

$notes = @"
# VoiceKeys $Version

构建时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm')
包大小：$([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB
SHA256：$hash

## 安装
解压后运行 ``start.cmd``（或 ``node app/server.js --port 19600 --open``）。
模型不入包，首次运行自动下载。

## 校验
``Get-FileHash .\$name.zip -Algorithm SHA256`` 应与上面一致。
"@
$notesPath = Join-Path $dist ("release-notes-" + $Version + ".md")
$notes | Set-Content -Path $notesPath -Encoding UTF8

Write-Host ""
Write-Host "完成："
Write-Host "  $zip"
Write-Host "  $zip.sha256"
Write-Host "  $notesPath"
