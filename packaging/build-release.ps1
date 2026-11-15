# 打一个可直接运行的 Windows 包（免装 Node）
#
# 用法：powershell -ExecutionPolicy Bypass -File packaging/build-release.ps1
# 产物：dist/VoiceKeys-win-x64/        目录（可直接运行）
#       dist/VoiceKeys-win-x64.zip     发布用压缩包
#       dist/SHA256.txt                校验值
#
# 为什么不打成"单文件 exe"：sherpa-onnx 的 onnxruntime.dll 和 pvrecorder 的 .node
# 都是原生二进制，pkg / Node SEA 都塞不进快照，硬塞就得运行时解压到临时目录，
# 而且用户就改不了算法文件了。所以发布"便携目录 + 启动器 exe"，双击即用。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dist = Join-Path $root 'dist'
$out = Join-Path $dist 'VoiceKeys-win-x64'
$node = (Get-Command node).Source
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

Write-Host '== 1/6 清理 ==' -ForegroundColor Cyan
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $out 'runtime') -Force | Out-Null

Write-Host '== 2/6 复制代码 ==' -ForegroundColor Cyan
foreach ($d in @('app','src','scripts','examples','docs','test','runtime')) {
  $src = Join-Path $root $d
  if (Test-Path $src) { Copy-Item $src (Join-Path $out $d) -Recurse -Force }
}
foreach ($f in @('README.md','LICENSE','NOTICE','start.cmd','package.json')) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $out $f) -Force }
}

Write-Host '== 3/6 复制运行时依赖 ==' -ForegroundColor Cyan
Copy-Item $node (Join-Path $out 'runtime\node.exe') -Force
Copy-Item (Join-Path $root 'lib') (Join-Path $out 'lib') -Recurse -Force

Write-Host '== 4/6 编译启动器 ==' -ForegroundColor Cyan
$exe = Join-Path $out 'VoiceKeys.exe'
& $csc /nologo /target:winexe /out:$exe /optimize+ (Join-Path $root 'packaging\launcher.cs') | Out-Null
if (-not (Test-Path $exe)) { throw '启动器编译失败' }

Write-Host '== 5/6 冒烟：用包里的 node 起一次服务 ==' -ForegroundColor Cyan
$smoke = Join-Path $dist '.smoke-data'
$outLog = Join-Path $dist '.smoke.out'
$errLog = Join-Path $dist '.smoke.err'
if (Test-Path $smoke) { Remove-Item $smoke -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
$env:VOICEKEYS_DATA = $smoke
$p = Start-Process (Join-Path $out 'runtime\node.exe') -ArgumentList "`"$(Join-Path $out 'app\server.js')`"","--port","19699" -WorkingDirectory $out -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$ok = $false
$state = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:19699/api/state' -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; $state = $r.Content | ConvertFrom-Json; break }
  } catch { }
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
Remove-Item Env:\VOICEKEYS_DATA -ErrorAction SilentlyContinue
if (-not $ok) {
  Get-Content $errLog -Tail 10 -ErrorAction SilentlyContinue
  throw '包里跑不起来'
}
$words = @($state.words).Count
Write-Host ('   服务正常：词 ' + $words + ' 个，模型就绪=' + [bool]$state.models.ok) -ForegroundColor Green
if ($words -lt 1) { throw '首次运行没播种示例词表' }
Remove-Item $smoke -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue

Write-Host '== 6/6 打包 ==' -ForegroundColor Cyan
$zip = Join-Path $dist 'VoiceKeys-win-x64.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
"$hash  VoiceKeys-win-x64.zip" | Set-Content (Join-Path $dist 'SHA256.txt') -Encoding utf8
Write-Host ('   zip: ' + [math]::Round((Get-Item $zip).Length / 1MB, 1) + ' MB') -ForegroundColor Green
Write-Host ('   sha256: ' + $hash)
