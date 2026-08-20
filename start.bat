@echo off
title dual-agent - 双层 Agent 自迭代系统
chcp 65001 >nul
cd /d "%~dp0"

rem ========== Clash VPN 代理检测与处理 ==========
echo 正在检测 Clash VPN 代理设置...

rem 检测系统代理设置
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable 2>nul | findstr "0x1" >nul
if not errorlevel 1 (
    reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2>nul | findstr /i "clash" >nul
    if not errorlevel 1 (
        echo 检测到 Clash VPN 代理，临时禁用系统代理...
        set DISABLE_PROXY=1
        reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul 2>&1
    )
)

rem 检测 Clash for Windows / Clash Verge 专用端口
set CLASH_PORTS=7890,7891,7892,7893,7894,7895
for %%p in (%CLASH_PORTS%) do (
    netstat -an | findstr "%%p" | findstr "LISTENING" >nul
    if not errorlevel 1 (
        echo 检测到 Clash 服务运行在端口 %%p
        set CLASH_RUNNING=1
        goto :clash_found
    )
)
:clash_found

rem ========== 端口检测与启动 ==========
set "PORT=3788"
if not "%DUAL_AGENT_PORT%"=="" set "PORT=%DUAL_AGENT_PORT%"

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js
    echo 请先安装 Node.js 18+ : https://nodejs.org/
    pause
    exit /b 1
)

echo.
echo 正在启动 dual-agent...
echo 端口: %PORT%
echo.

rem 启动服务器（前台运行，关闭窗口即停止）
node server.js --port %PORT%

rem ========== 恢复代理设置 ==========
if "%DISABLE_PROXY%"=="1" (
    echo.
    echo 正在恢复代理设置...
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f >nul 2>&1
)

echo.
echo 服务器已停止
pause
