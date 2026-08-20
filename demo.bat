@echo off
title dual-agent - 演示模式
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo  dual-agent 演示模式
echo ========================================
echo.
echo 此模式无需配置 API Key，即可体验完整功能。
echo 内层使用模拟 LLM，外层使用模拟 OpenCode。
echo.
echo 按 Ctrl+C 停止演示
echo.

set DUAL_AGENT_MOCK=1
set DUAL_AGENT_PORT=%~1

if "%DUAL_AGENT_PORT%"=="" set DUAL_AGENT_PORT=3788

node server.js --port %DUAL_AGENT_PORT%
