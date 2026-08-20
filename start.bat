@echo off
title dual-agent
chcp 65001 >nul
cd /d "%~dp0"

rem ---------- 一键启动：自动挑空闲端口 → 后台起服务 → 就绪后打开浏览器 ----------
rem 自定义起始端口：set DUAL_AGENT_PORT=3800 && start.bat

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 18+ 版本：https://nodejs.org/
  pause
  exit /b 1
)

set "PORT=3788"
if not "%DUAL_AGENT_PORT%"=="" set "PORT=%DUAL_AGENT_PORT%"
set /a TRIES=0

:pickport
node tools\probe.js %PORT% free >nul 2>nul
if errorlevel 1 goto notfree
goto startsvr

:notfree
rem 端口有响应：若已是本程序在跑，直接开浏览器复用
node tools\probe.js %PORT% ours >nul 2>nul
if not errorlevel 1 (
  start "" http://localhost:%PORT%/
  exit /b 0
)
set /a TRIES+=1
if %TRIES% gtr 8 (
  echo 端口 3788-3796 都被其他程序占用，请检查后重试
  pause
  exit /b 1
)
set /a PORT+=1
goto pickport

:startsvr
rem 最小化窗口启动服务（关闭该窗口即停止服务）
start "dual-agent-server" /min node server.js --port %PORT%
echo 正在启动 dual-agent（端口 %PORT%，首次启动可能需十几秒）...
set /a WAIT=45

:poll
ping -n 3 127.0.0.1 >nul
node tools\probe.js %PORT% ready >nul 2>nul
if not errorlevel 1 (
  echo 服务已就绪，正在打开浏览器...
  start "" http://localhost:%PORT%/
  exit /b 0
)
set /a WAIT-=1
if %WAIT% leq 0 (
  echo 服务 90 秒未就绪：请手动运行 node server.js --port %PORT% 查看报错
  pause
  exit /b 1
)
goto poll
