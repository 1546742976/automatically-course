@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.12 or newer: https://nodejs.org/
  exit /b 1
)
node local\startup.cjs
if errorlevel 1 exit /b 1
node local\main.cjs
exit /b %errorlevel%
