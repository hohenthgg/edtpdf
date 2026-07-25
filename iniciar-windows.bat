@echo off
setlocal
cd /d "%~dp0"
start "Natural PDF Studio" http://localhost:4173
where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 4173
) else (
  python -m http.server 4173
)
endlocal
