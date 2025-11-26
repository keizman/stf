# STF 快速启动指南

## 问题：`stf: command not found`

### 解决方案

#### 方法一：使用启动脚本（推荐）

已创建启动脚本，可以直接使用：

```bash
cd /opt/pkg/stf
./stf-local.sh --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
```

或使用全局命令（如果已创建符号链接）：
```bash
stf-local --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
```

#### 方法二：设置环境变量后使用 stf 命令

```bash
# 设置环境变量绕过版本检查（如果 Node.js 版本 < 18.20.5）
export ALLOW_OUTDATED_DEPENDENCIES=1

# 使用 stf 命令
stf local --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
```

#### 方法三：直接使用 node 运行

```bash
cd /opt/pkg/stf
export ALLOW_OUTDATED_DEPENDENCIES=1
node bin/stf local --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
```

#### 方法四：使用 npm run

```bash
cd /opt/pkg/stf
export ALLOW_OUTDATED_DEPENDENCIES=1
npm run local -- --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
```

## Node.js 版本问题

当前 Node.js 版本：v16.20.2  
STF 要求：>= 18.20.5（但 <= 20.x）

### 升级 Node.js（推荐）

使用 nvm 安装 Node.js 20：

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc

# 安装并使用 Node.js 20
nvm install 20
nvm use 20
nvm alias default 20

# 验证版本
node -v  # 应该显示 v20.x.x
```

### 临时绕过版本检查

如果暂时无法升级 Node.js，可以设置环境变量：

```bash
export ALLOW_OUTDATED_DEPENDENCIES=1
```

**注意**：这可能导致兼容性问题，建议尽快升级 Node.js。

## 完整启动流程

### 1. 启动 RethinkDB（Docker）

```bash
docker run -d \
    --name rethinkdb \
    --restart unless-stopped \
    -v rethinkdb-data:/data \
    -p 8080:8080 \
    -p 28015:28015 \
    -p 29015:29015 \
    rethinkdb:2.4.2 \
    rethinkdb --bind all --cache-size 2048
```

### 2. 启动 STF

```bash
cd /opt/pkg/stf
export ALLOW_OUTDATED_DEPENDENCIES=1  # 如果 Node.js 版本 < 18.20.5
./stf-local.sh --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
```

### 3. 访问 STF

打开浏览器访问：http://localhost:7100

## 常用命令

### 查看 STF 版本
```bash
export ALLOW_OUTDATED_DEPENDENCIES=1
stf --version
```

### 查看帮助
```bash
export ALLOW_OUTDATED_DEPENDENCIES=1
stf local --help
```

### 检查 RethinkDB 连接
```bash
docker ps | grep rethinkdb
docker logs rethinkdb
```

## 故障排查

### 问题：仍然提示 `stf: command not found`

**解决**：
```bash
# 检查符号链接
ls -la /usr/local/bin/stf

# 如果不存在，创建符号链接
cd /opt/pkg/stf
sudo ln -sf $(pwd)/bin/stf /usr/local/bin/stf

# 或使用启动脚本
./stf-local.sh --help
```

### 问题：Node.js 版本错误

**解决**：
```bash
# 设置环境变量
export ALLOW_OUTDATED_DEPENDENCIES=1

# 或升级 Node.js（推荐）
nvm install 20
nvm use 20
```

### 问题：无法连接 RethinkDB

**检查**：
```bash
# 1. 确认 RethinkDB 正在运行
docker ps | grep rethinkdb

# 2. 测试端口连接
telnet localhost 28015

# 3. 查看 RethinkDB 日志
docker logs rethinkdb
```

## 一键启动脚本

创建 `~/.bashrc` 或 `~/.zshrc` 别名：

```bash
# 添加到 ~/.bashrc
alias stf-local='cd /opt/pkg/stf && export ALLOW_OUTDATED_DEPENDENCIES=1 && node bin/stf local'
```

然后：
```bash
source ~/.bashrc
stf-local --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
```

