@echo off
rem Keep this file ASCII-only. cmd.exe parses .bat in the system ANSI codepage,
rem so UTF-8 Chinese here would turn into broken commands.
rem All user-facing text lives in scripts/setup.mjs (Node prints proper UTF-8).
chcp 65001 >nul
title GuGu Music Player
cd /d "%~dp0"

rem Prefer the bundled runtime so users do not need to install Node.js.
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" goto run

rem Fall back to a system-wide Node install.
where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE_EXE=node"
goto run

:nonode
echo.
echo   Node.js not found, and the bundled runtime is missing.
echo   Please re-download the package, or install Node.js from https://nodejs.org
echo.
pause
exit /b 1

:run
"%NODE_EXE%" scripts\setup.mjs %*
set "EXITCODE=%errorlevel%"

echo.
if not "%EXITCODE%"=="0" echo   Stopped with exit code %EXITCODE%.
pause
