@echo off
rem VoiceKeys 启动器（备用入口）：双击即可运行
rem 优先用包里自带的 runtime\node.exe；没有才退回系统 node
rem 可选参数原样传给 app\server.js，例如 start.cmd --port 19601
setlocal
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [VoiceKeys] 找不到运行时。请用 VoiceKeys.exe 启动，或安装 Node.js 22+：https://nodejs.org/
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

if "%~1"=="" (
  "%NODE_EXE%" app\server.js --port 19600 --open
) else (
  "%NODE_EXE%" app\server.js %*
)
