@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.12 or newer: https://nodejs.org/
  exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22 || major===22 && minor>=12 ? 0:1)"
if errorlevel 1 (
  echo Please update Node.js to 22.12 or newer: https://nodejs.org/
  exit /b 1
)
if not exist "node_modules\playwright\package.json" goto install_dependencies
if not exist "node_modules\electron\package.json" goto install_dependencies
goto run_assistant
:install_dependencies
echo First start: installing local dependencies. Please wait...
call npm install --omit=dev
if errorlevel 1 exit /b 1
:run_assistant
node local\main.cjs
exit /b %errorlevel%
