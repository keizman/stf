#!/bin/bash
# STF 依赖安装脚本 - RHEL/CentOS/Fedora (dnf)
# 适用于 RHEL 8+, CentOS Stream, Fedora

# 不使用 set -e，允许某些命令失败后继续执行
set -u  # 只检查未定义变量

echo "=========================================="
echo "STF 依赖安装脚本 (RHEL/CentOS/Fedora)"
echo "=========================================="

# 检查是否为 root 用户
if [ "$EUID" -ne 0 ]; then 
    echo "请使用 sudo 运行此脚本"
    exit 1
fi

# 1. 安装基础开发工具
echo ""
echo "[1/7] 安装基础开发工具..."
# 尝试安装开发工具组（如果存在）
if dnf group list "Development Tools" 2>/dev/null | grep -q "Development Tools"; then
    echo "安装 Development Tools 组..."
    dnf groupinstall -y "Development Tools" 2>&1 || echo "警告: 无法安装 Development Tools 组，将单独安装包"
fi
# 直接安装必需的开发工具包（即使组安装失败也能继续）
echo "安装基础开发包: gcc gcc-c++ make python3 python3-devel..."
if ! dnf install -y gcc gcc-c++ make python3 python3-devel 2>&1; then
    echo "错误: 无法安装基础开发工具"
    exit 1
fi

# 2. 安装 CMake (>= 3.9)
echo ""
echo "[2/7] 安装 CMake..."
if ! dnf install -y cmake 2>&1; then
    echo "错误: 无法安装 CMake"
    exit 1
fi

# 3. 安装 GraphicsMagick
echo ""
echo "[3/7] 安装 GraphicsMagick..."
if ! dnf install -y GraphicsMagick GraphicsMagick-devel 2>&1; then
    echo "错误: 无法安装 GraphicsMagick"
    exit 1
fi

# 4. 安装 ZeroMQ
echo ""
echo "[4/7] 安装 ZeroMQ..."
if ! dnf install -y zeromq zeromq-devel 2>&1; then
    echo "错误: 无法安装 ZeroMQ"
    exit 1
fi

# 5. 安装 Protocol Buffers
echo ""
echo "[5/7] 安装 Protocol Buffers..."
if ! dnf install -y protobuf protobuf-devel protobuf-compiler 2>&1; then
    echo "错误: 无法安装 Protocol Buffers"
    exit 1
fi

# 6. 安装 yasm 和 pkg-config
echo ""
echo "[6/7] 安装 yasm 和 pkg-config..."
if ! dnf install -y yasm pkgconfig pkg-config 2>&1; then
    echo "错误: 无法安装 yasm 或 pkg-config"
    exit 1
fi

# 7. 安装 Node.js (最高 20.x)
echo ""
echo "[7/7] 安装 Node.js..."
# 检查是否已安装 Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -gt 20 ]; then
        echo "警告: 检测到 Node.js 版本 > 20.x，STF 需要 Node.js <= 20.x"
        echo "建议使用 nvm 安装 Node.js 20.x:"
        echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
        echo "  nvm install 20"
        echo "  nvm use 20"
    else
        echo "Node.js 已安装: $(node -v)"
    fi
else
    # 使用 NodeSource 仓库安装 Node.js 20.x
    echo "从 NodeSource 安装 Node.js 20.x..."
    dnf install -y curl
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
fi

# 8. 安装 RethinkDB (>= 2.2)
echo ""
echo "[8/8] 安装 RethinkDB..."
# 检查 RethinkDB 是否已安装
if command -v rethinkdb &> /dev/null; then
    echo "RethinkDB 已安装: $(rethinkdb --version | head -n1)"
else
    # RethinkDB 官方已停止维护，使用社区维护的版本或从源码编译
    # 方法1: 尝试从 EPEL 安装（如果可用）
    if dnf repolist | grep -q epel; then
        echo "尝试从 EPEL 安装 RethinkDB..."
        dnf install -y epel-release
        dnf install -y rethinkdb || {
            echo "EPEL 中没有 RethinkDB，尝试其他方法..."
        }
    fi
    
    # 方法2: 从 GitHub releases 下载预编译版本
    if ! command -v rethinkdb &> /dev/null; then
        echo "从 GitHub 下载 RethinkDB..."
        ARCH=$(uname -m)
        if [ "$ARCH" = "x86_64" ]; then
            RETHINKDB_URL="https://github.com/rethinkdb/rethinkdb/releases/download/v2.4.2/rethinkdb-2.4.2.tgz"
        else
            echo "警告: 未找到对应架构的预编译版本，需要从源码编译"
            RETHINKDB_URL=""
        fi
        
        if [ -n "$RETHINKDB_URL" ]; then
            cd /tmp
            wget "$RETHINKDB_URL" -O rethinkdb.tgz
            tar xzf rethinkdb.tgz
            cd rethinkdb-2.4.2
            # 安装依赖
            dnf install -y boost-devel ncurses-devel openssl-devel
            ./configure --allow-fetch
            make -j$(nproc)
            make install
            cd -
            rm -rf /tmp/rethinkdb*
        fi
    fi
fi

# 9. 安装 ADB (Android Debug Bridge)
echo ""
echo "[额外] 检查 ADB..."
if ! command -v adb &> /dev/null; then
    echo "安装 Android Platform Tools (ADB)..."
    # 方法1: 从 Google 官方下载
    cd /tmp
    wget https://dl.google.com/android/repository/platform-tools-latest-linux.zip
    unzip platform-tools-latest-linux.zip
    cp platform-tools/adb /usr/local/bin/
    chmod +x /usr/local/bin/adb
    rm -rf platform-tools* platform-tools-latest-linux.zip
    echo "ADB 已安装到 /usr/local/bin/adb"
else
    echo "ADB 已安装: $(adb version | head -n1)"
fi

# 验证安装
echo ""
echo "=========================================="
echo "安装完成！验证安装的版本："
echo "=========================================="
echo "Node.js: $(node -v 2>/dev/null || echo '未安装')"
echo "npm: $(npm -v 2>/dev/null || echo '未安装')"
echo "CMake: $(cmake --version | head -n1 2>/dev/null || echo '未安装')"
echo "GraphicsMagick: $(gm version | head -n1 2>/dev/null || echo '未安装')"
echo "ZeroMQ: $(pkg-config --modversion libzmq 2>/dev/null || echo '未安装')"
echo "Protocol Buffers: $(protoc --version 2>/dev/null || echo '未安装')"
echo "yasm: $(yasm --version | head -n1 2>/dev/null || echo '未安装')"
echo "pkg-config: $(pkg-config --version 2>/dev/null || echo '未安装')"
echo "RethinkDB: $(rethinkdb --version | head -n1 2>/dev/null || echo '未安装')"
echo "ADB: $(adb version | head -n1 2>/dev/null || echo '未安装')"
echo ""
echo "如果所有依赖都已正确安装，现在可以运行:"
echo "  cd /opt/pkg/stf"
echo "  npm install"
echo "  rethinkdb  # 在另一个终端启动数据库"
echo "  stf local   # 启动 STF"
echo "=========================================="

