@echo off
setlocal enabledelayedexpansion
set "INPUT="
for /f "delims=" %%L in ('more') do set "INPUT=%%L"
echo {"ok":true,"echo":"%INPUT%","note":"custom action ran"}
