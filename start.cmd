@echo off
rem VoiceKeys 启动器：双击即可运行
rem 可选参数会原样传给 app/server.js，例如 start.cmd --port 19600 --open
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [VoiceKeys] 没找到 Node.js。请先安装 Node.js 22 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if "%~1"=="" (
  node app\server.js --port 19600 --open
) else (
  node app\server.js %*
)
