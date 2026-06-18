@echo off
echo Starting Market Intelligence Server...
cd /d "%~dp0"

:: Start the server in a new command window
start "Ebay Market Intelligence Server" cmd /k "npm start"

:: Wait for 3 seconds   to let the server start
timeout /t 3 /nobreak >nul

:: Open the browser
start http://127.0.0.1:3000

exit