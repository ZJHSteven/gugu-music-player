@echo off
chcp 65001 > nul
title 咕咕点歌台 - 卸载
cd /d "%~dp0"

echo.
echo   咕咕点歌台 卸载
echo   ==================
echo.
echo   这会关闭正在运行的服务，并删除程序文件。
echo.

choice /c YN /m "  确定要卸载吗"
if errorlevel 2 goto cancel

echo.
echo   [1/3] 关闭正在运行的服务...
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq node.exe" /fo table /nh 2^>nul') do (
  wmic process where "ProcessId=%%p" get ExecutablePath 2>nul | find /i "咕咕点歌台" >nul && taskkill /f /pid %%p >nul 2>&1
)
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq cloudflared.exe" /fo table /nh 2^>nul') do (
  taskkill /f /pid %%p >nul 2>&1
)

echo   [2/3] 删除歌单与缓存...
if exist "data" rd /s /q "data" 2>nul

echo   [3/3] 删除程序文件...
echo.
echo   注意：还需要你手动做一步——
echo     打开 Owlbear Rodeo，左下角三个点 → Extension
echo     把「咕咕点歌台」删掉，否则那里会留一个打不开的图标
echo.
pause

echo   正在删除本目录...
cd /d "%TEMP%"
start "" /b cmd /c "timeout /t 2 >nul & rd /s /q "%~dp0""
exit

:cancel
echo.
echo   已取消。
timeout /t 2 >nul
exit
