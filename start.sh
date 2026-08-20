#!/bin/bash
# dual-agent 一键启动脚本（Linux/macOS）
# 用法: ./start.sh 或 DUAL_AGENT_PORT=3800 ./start.sh

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

cd "$(dirname "$0")" || exit 1

echo -e "${GREEN}dual-agent 双层 Agent 自迭代系统${NC}"
echo "================================"

# 检查 Node.js
if ! command -v node &>/dev/null; then
    echo -e "${RED}[错误] 未检测到 Node.js${NC}"
    echo "请先安装 Node.js 18+: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}[错误] Node.js 版本需 18+，当前: $(node -v)${NC}"
    exit 1
fi

# 端口配置
PORT="${DUAL_AGENT_PORT:-3788}"
echo "端口: $PORT"

# 检测并处理代理冲突
check_proxy_conflict() {
    local clash_ports="7890 7891 7892 7893 7894 7895"
    for p in $clash_ports; do
        if command -v lsof &>/dev/null; then
            if lsof -i :$p &>/dev/null; then
                echo -e "${YELLOW}[提示] 检测到 Clash 服务运行在端口 $p${NC}"
                return 0
            fi
        elif command -v netstat &>/dev/null; then
            if netstat -an | grep ":$p " | grep -q LISTEN; then
                echo -e "${YELLOW}[提示] 检测到 Clash 服务运行在端口 $p${NC}"
                return 0
            fi
        fi
    done
    return 1
}

check_proxy_conflict || true

# 检查端口是否被占用
ifcommand -v lsof &>/dev/null; then
    if lsof -i :$PORT &>/dev/null; then
        echo -e "${YELLOW}[警告] 端口 $PORT 已被占用${NC}"
        echo "如需使用其他端口: DUAL_AGENT_PORT=3800 ./start.sh"
        read -p "按回车继续（将尝试使用现有进程）或 Ctrl+C 取消... " 2>/dev/null || true
    fi
elif command -v netstat &>/dev/null; then
    if netstat -an | grep ":$PORT " | grep -q LISTEN; then
        echo -e "${YELLOW}[警告] 端口 $PORT 已被占用${NC}"
    fi
fi

echo ""
echo -e "${GREEN}正在启动服务器...${NC}"
echo "访问地址: http://localhost:$PORT"
echo "按 Ctrl+C 停止服务器"
echo ""

# 启动服务器（前台运行，Ctrl+C 停止）
exec node server.js --port "$PORT"
