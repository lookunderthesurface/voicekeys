@echo off
rem 开发者启动：校准默认开启（VK_DEV=1），其余与普通启动一致
set VK_DEV=1
cd /d "%~dp0"
start "" "%~dp0runtime\node.exe" "%~dp0app\server.js" --port 19600 --open
