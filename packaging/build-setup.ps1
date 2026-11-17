# 构建 Windows 安装包
#
# 产物：
#   dist/VoiceKeys-Setup-<ver>.exe      单文件安装器（payload 嵌入资源）
#   dist/VoiceKeys-Setup-<ver>.zip      压缩包，里面就放那个 setup（用户要的形式）
#   dist/SHA256.txt
#
# 为什么自己写安装器：本机没有 Inno Setup / NSIS，而 .NET Framework 的 csc 是 Windows 自带，
# 用户不需要装任何工具；按用户安装（%LOCALAPPDATA%\Programs\VoiceKeys），不需要管理员权限。
#
# 用法：powershell -ExecutionPolicy Bypass -File packaging/build-setup.ps1 [-Version 0.2.5]

param([string]$Version = '0.2.5')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'setup-stage'
$payloadDir = Join-Path $stage 'payload'
$node = (Get-Command node).Source
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$icon = Join-Path $root 'packaging\icon\VoiceKeys.ico'
$manifest = Join-Path $root 'packaging\setup.manifest'
$csRefs = @('/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll')

Write-Host '== 1/8 清理 ==' -ForegroundColor Cyan
foreach ($p in @($stage, (Join-Path $dist "VoiceKeys-Setup-$Version.exe"), (Join-Path $dist "VoiceKeys-Setup-$Version.zip"))) {
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $payloadDir 'runtime') -Force | Out-Null

Write-Host '== 2/8 组装 payload ==' -ForegroundColor Cyan
foreach ($d in @('app','src','scripts','examples','docs','lib')) {
  Copy-Item (Join-Path $root $d) (Join-Path $payloadDir $d) -Recurse -Force
}
Copy-Item (Join-Path $root 'runtime\worker.ps1') (Join-Path $payloadDir 'runtime\worker.ps1') -Force
Copy-Item $node (Join-Path $payloadDir 'runtime\node.exe') -Force
foreach ($f in @('README.md','LICENSE','NOTICE','start.cmd')) {
  Copy-Item (Join-Path $root $f) (Join-Path $payloadDir $f) -Force
}
$nested = Join-Path $payloadDir 'runtime\runtime'
if (Test-Path $nested) {
  Get-ChildItem $nested -Force | ForEach-Object { Move-Item $_.FullName (Join-Path $payloadDir 'runtime') -Force }
  Remove-Item $nested -Recurse -Force
}
@'
@echo off
"%~dp0VoiceKeys.exe" --stop
'@ | Set-Content (Join-Path $payloadDir 'stop.cmd') -Encoding ascii

Write-Host '== 3/8 编译启动器（必须在打包前） ==' -ForegroundColor Cyan
$launcherExe = Join-Path $payloadDir 'VoiceKeys.exe'
$out = & $csc /nologo /target:winexe /out:$launcherExe /optimize+ /win32icon:$icon /win32manifest:$manifest (Join-Path $root 'packaging\launcher.cs') 2>&1
if (-not (Test-Path $launcherExe)) {
  $out | ForEach-Object { Write-Host ('   ' + $_) -ForegroundColor Red }
  throw '启动器编译失败'
}
Write-Host ('   VoiceKeys.exe: ' + [math]::Round((Get-Item $launcherExe).Length / 1KB, 1) + ' KB')

Write-Host '== 3.5/8 编译卸载器（约 10KB，替换原来 45MB 的自复制） ==' -ForegroundColor Cyan
$uninstExe = Join-Path $payloadDir 'uninstall.exe'
$out3 = & $csc /nologo /target:winexe /out:$uninstExe /optimize+ /win32icon:$icon /win32manifest:$manifest (Join-Path $root 'packaging\uninstaller.cs') 2>&1
if (-not (Test-Path $uninstExe)) {
  $out3 | ForEach-Object { Write-Host ('   ' + $_) -ForegroundColor Red }
  throw '卸载器编译失败'
}
Write-Host ('   uninstall.exe: ' + [math]::Round((Get-Item $uninstExe).Length / 1KB, 1) + ' KB')
Write-Host '== 4/8 打 payload.zip ==' -ForegroundColor Cyan
$payloadZip = Join-Path $stage 'payload.zip'
Compress-Archive -Path (Join-Path $payloadDir '*') -DestinationPath $payloadZip -CompressionLevel Optimal
Write-Host ('   payload: ' + [math]::Round((Get-Item $payloadZip).Length / 1MB, 1) + ' MB')

Write-Host '== 5/8 编译安装器 ==' -ForegroundColor Cyan
$setupExe = Join-Path $dist "VoiceKeys-Setup-$Version.exe"
$out2 = & $csc /nologo /target:winexe /out:$setupExe /optimize+ /win32icon:$icon /win32manifest:$manifest /resource:$payloadZip,payload.zip @csRefs (Join-Path $root 'packaging\setup.cs') 2>&1
if (-not (Test-Path $setupExe)) {
  $out2 | ForEach-Object { Write-Host ('   ' + $_) -ForegroundColor Red }
  throw '安装器编译失败'
}
Write-Host ('   setup.exe: ' + [math]::Round((Get-Item $setupExe).Length / 1MB, 1) + ' MB')

Write-Host '== 6/8 冒烟：静默安装到工作区临时目录并自检 ==' -ForegroundColor Cyan
$testDir = Join-Path $stage 'test-install'
$testLog = Join-Path $stage 'install-test.log'
$env:VOICEKEYS_INSTALL_DIR = $testDir
$env:VOICEKEYS_LOG_FILE = $testLog
try {
  # 注意：winexe + Start-Process -Wait 在这种沙箱里会报"操作被用户取消"，直接调用即可
  $global:LASTEXITCODE = 0
  & $setupExe --silent --no-shortcuts | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Get-Content $testLog -Tail 10 -ErrorAction SilentlyContinue
    throw ('安装器返回 ' + $LASTEXITCODE)
  }
  if (-not (Test-Path (Join-Path $testDir 'app\server.js'))) { throw '安装后找不到 app\server.js' }
  if (-not (Test-Path (Join-Path $testDir 'VoiceKeys.exe'))) { throw '安装后找不到启动器' }
  $files = Get-ChildItem $testDir -Recurse -File
  $sum = ($files | Measure-Object Length -Sum).Sum
  Write-Host ('   已安装 ' + $files.Count + ' 个文件，' + [math]::Round($sum / 1MB, 1) + ' MB') -ForegroundColor Green

  $env:VOICEKEYS_DATA = Join-Path $stage 'smoke-data'
  $nodeExe = Join-Path $testDir 'runtime\node.exe'
  $srv = Start-Process $nodeExe -ArgumentList "`"$(Join-Path $testDir 'app\server.js')`"",'--port','19700' -WorkingDirectory $testDir -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stage 'smoke.out') -RedirectStandardError (Join-Path $stage 'smoke.err')
  $ok = $false
  for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:19700/api/selfcheck' -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) {
        $sc = $r.Content | ConvertFrom-Json
        # 包里不带模型（体积+许可），所以只允许「模型文件」这两项失败，其它必须全过
        $allowed = @('M1 模型文件', 'M2 模型文件')
        $bad = @($sc.failed | Where-Object { $allowed -notcontains $_ })
        if ($bad.Count -eq 0) { $ok = $true; $selfcheckFailed = @($sc.failed); break }
      }
    } catch { }
  }
  if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
  if (-not $ok) {
    Get-Content (Join-Path $stage 'smoke.err') -Tail 12 -ErrorAction SilentlyContinue
    throw '安装后的程序自检没通过'
  }
  Write-Host ('   安装后的程序自检通过（缺模型属正常：' + ($selfcheckFailed -join '、') + '）') -ForegroundColor Green
} finally {
  Remove-Item Env:\VOICEKEYS_INSTALL_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\VOICEKEYS_LOG_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:\VOICEKEYS_DATA -ErrorAction SilentlyContinue
}

Write-Host '== 7/8 校验值 ==' -ForegroundColor Cyan
$h1 = (Get-FileHash $setupExe -Algorithm SHA256).Hash
"$h1  VoiceKeys-Setup-$Version.exe" | Set-Content (Join-Path $dist 'SHA256.txt') -Encoding utf8
Write-Host ('   setup sha256: ' + $h1)

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '完成（只产出 setup.exe；用户不需要先解压 zip）' -ForegroundColor Green