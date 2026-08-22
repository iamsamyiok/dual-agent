@echo off
rem hwj 终端智能体 — Windows 双击启动（经 WSL 运行 Node TUI）
rem 环境变量：HWJ_HOME 可指定 dual-agent 的 WSL 侧绝对路径（默认自动推断）
title hwj 终端智能体
chcp 65001 >nul

rem ---- 1. WSL 存在性 ----
where wsl >nul 2>nul
if errorlevel 1 goto nowsl

rem ---- 2. 定位 dual-agent 的 WSL 路径 ----
if not "%HWJ_HOME%"=="" (
  wsl.exe -e bash -c "test -f '%HWJ_HOME%/hwj/hwj.js'" >nul 2>nul
  if not errorlevel 1 set "WSHOME=%HWJ_HOME%" & goto checknode
  echo [hwj] HWJ_HOME 指向的路径无效：%HWJ_HOME%（找不到 hwj/hwj.js）
  goto fail
)

rem 2a. 把双击位置（bat 所在 Windows 目录）映射为 WSL 路径
for /f "usebackq delims=" %%i in (`wsl.exe wslpath -a "%~dp0."`) do set "WSHOME=%%i"
if not "%WSHOME%"=="" (
  wsl.exe -e bash -c "test -f '%WSHOME%/hwj/hwj.js'" >nul 2>nul
  if not errorlevel 1 goto checknode
)

rem 2b. 兜底探测常见安装位置
for %%d in (~/dual-agent /workspace/dual-agent ~/agents-chat/dual-agent) do (
  wsl.exe -e bash -c "test -f %%d/hwj/hwj.js" >nul 2>nul
  if not errorlevel 1 set "WSHOME=%%d" & goto checknode
)

echo [hwj] 未找到 hwj/hwj.js——请确认 dual-agent 仓库位置。
echo        可设置环境变量 HWJ_HOME 指向 dual-agent 的 WSL 侧绝对路径（如 /workspace/dual-agent）后重试。
goto fail

:checknode
rem ---- 3. WSL 内 Node.js 存在性与版本（≥18） ----
wsl.exe -e bash -lc "command -v node >/dev/null 2>&1 || exit 1; v=$(node -v 2>/dev/null | sed 's/v//;s/\..*//'); [ \"$v\" -ge 18 ] 2>/dev/null || exit 2" >nul 2>nul
if errorlevel 2 goto badnode
if errorlevel 1 goto nonode

rem ---- 4. 启动 hwj TUI（exec 让 node 接管进程，Ctrl+C 直达） ----
wsl.exe -e bash -lc "cd '%WSHOME%' && exec node hwj/hwj.js"
set "EC=%errorlevel%"
if "%EC%"=="0" exit /b 0
echo.
echo [hwj] 已退出（代码 %EC%）
pause
exit /b %EC%

:nowsl
echo [hwj] 未检测到 WSL。安装方法（管理员 PowerShell）：
echo        wsl --install -d Ubuntu
echo        安装完成后重启电脑，再双击本脚本。
goto fail

:nonode
echo [hwj] WSL 内未安装 Node.js。安装方法（WSL 终端内执行）：
echo        sudo apt update ^&^& sudo apt install -y curl
echo        curl -fsSL https://deb.nodesource.com/setup_20.x ^| sudo -E bash -
echo        sudo apt install -y nodejs
goto fail

:badnode
echo [hwj] WSL 内 Node.js 版本低于 18（hwj 需要 18+）。请升级：
echo        sudo apt remove -y nodejs ^&^& curl -fsSL https://deb.nodesource.com/setup_20.x ^| sudo -E bash - ^&^& sudo apt install -y nodejs
goto fail

:fail
echo.
pause
exit /b 1
