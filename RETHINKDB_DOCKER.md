# RethinkDB Docker 启动指南

本文档说明如何仅使用 Docker 启动 RethinkDB，而其他 STF 组件使用命令行启动。

## 方法一：使用启动脚本（推荐）

```bash
cd /opt/pkg/stf
./start-rethinkdb-docker.sh
```

脚本会自动：
- 检查容器是否已存在
- 创建数据卷（如果不存在）
- 启动 RethinkDB 容器
- 显示连接信息

## 方法二：使用 docker-compose（仅 RethinkDB）

```bash
cd /opt/pkg/stf
docker-compose -f docker-compose-rethinkdb-only.yaml up -d
```

查看状态：
```bash
docker-compose -f docker-compose-rethinkdb-only.yaml ps
```

停止：
```bash
docker-compose -f docker-compose-rethinkdb-only.yaml down
```

## 方法三：直接使用 docker run 命令

```bash
# 创建数据卷（首次运行）
docker volume create rethinkdb-data

# 启动 RethinkDB 容器
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

## 端口说明

- **8080**: Web 管理界面（http://localhost:8080）
- **28015**: 客户端驱动端口（STF 连接此端口）
- **29015**: 集群内通信端口

## 验证 RethinkDB 运行状态

```bash
# 查看容器状态
docker ps --filter "name=rethinkdb"

# 查看日志
docker logs rethinkdb

# 测试连接
docker exec -it rethinkdb rethinkdb --version
```

## 启动 STF（命令行方式）

RethinkDB 启动后，在另一个终端启动 STF：

```bash
cd /opt/pkg/stf

# 方式1: 使用默认配置（连接到 localhost:28015）
stf local

# 方式2: 指定 RethinkDB 地址（如果需要）
export RETHINKDB_PORT_28015_TCP=tcp://localhost:28015
stf local

# 方式3: 如果 RethinkDB 在其他主机
export RETHINKDB_PORT_28015_TCP=tcp://<RETHINKDB_HOST>:28015
stf local
```

## 常用管理命令

### 查看容器状态
```bash
docker ps --filter "name=rethinkdb" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### 查看日志
```bash
# 实时查看日志
docker logs -f rethinkdb

# 查看最近 100 行日志
docker logs --tail 100 rethinkdb
```

### 停止容器
```bash
docker stop rethinkdb
```

### 启动已停止的容器
```bash
docker start rethinkdb
```

### 重启容器
```bash
docker restart rethinkdb
```

### 删除容器（保留数据卷）
```bash
docker stop rethinkdb
docker rm rethinkdb
```

### 删除容器和数据卷（完全删除）
```bash
docker stop rethinkdb
docker rm rethinkdb
docker volume rm rethinkdb-data
```

## 数据持久化

数据存储在 Docker 卷 `rethinkdb-data` 中，即使删除容器，数据也会保留。

查看数据卷：
```bash
docker volume inspect rethinkdb-data
```

备份数据：
```bash
# 停止容器
docker stop rethinkdb

# 备份数据卷
docker run --rm \
    -v rethinkdb-data:/data \
    -v $(pwd):/backup \
    ubuntu tar czf /backup/rethinkdb-backup-$(date +%Y%m%d).tar.gz /data

# 启动容器
docker start rethinkdb
```

恢复数据：
```bash
# 停止容器
docker stop rethinkdb
docker rm rethinkdb

# 删除旧数据卷（可选）
docker volume rm rethinkdb-data

# 创建新数据卷
docker volume create rethinkdb-data

# 恢复数据
docker run --rm \
    -v rethinkdb-data:/data \
    -v $(pwd):/backup \
    ubuntu tar xzf /backup/rethinkdb-backup-YYYYMMDD.tar.gz -C /
```

## 配置调整

### 修改缓存大小

编辑启动脚本或 docker-compose 文件，修改 `--cache-size` 参数：

```bash
# 默认 2048MB，可以调整为其他值（单位：MB）
rethinkdb --bind all --cache-size 4096
```

### 绑定到特定 IP

如果只想绑定到 localhost：

```bash
docker run -d \
    --name rethinkdb \
    --restart unless-stopped \
    -v rethinkdb-data:/data \
    -p 127.0.0.1:8080:8080 \
    -p 127.0.0.1:28015:28015 \
    -p 127.0.0.1:29015:29015 \
    rethinkdb:2.4.2 \
    rethinkdb --bind 127.0.0.1 --cache-size 2048
```

### 使用网络模式 host

```bash
docker run -d \
    --name rethinkdb \
    --restart unless-stopped \
    --net host \
    -v rethinkdb-data:/data \
    rethinkdb:2.4.2 \
    rethinkdb --bind all --cache-size 2048
```

## 故障排查

### 容器无法启动

```bash
# 查看详细错误信息
docker logs rethinkdb

# 检查端口是否被占用
netstat -tuln | grep -E '8080|28015|29015'
# 或
ss -tuln | grep -E '8080|28015|29015'
```

### STF 无法连接 RethinkDB

1. 确认 RethinkDB 容器正在运行：
   ```bash
   docker ps | grep rethinkdb
   ```

2. 测试端口连接：
   ```bash
   telnet localhost 28015
   # 或
   nc -zv localhost 28015
   ```

3. 检查防火墙设置：
   ```bash
   # RHEL/CentOS/Fedora
   sudo firewall-cmd --list-ports
   sudo firewall-cmd --add-port=28015/tcp --permanent
   sudo firewall-cmd --reload
   ```

4. 确认 STF 环境变量设置正确：
   ```bash
   export RETHINKDB_PORT_28015_TCP=tcp://localhost:28015
   ```

## 访问 Web 管理界面

启动后访问：http://localhost:8080

在管理界面中可以：
- 查看数据库和表
- 运行查询
- 监控性能
- 管理用户和权限

## 注意事项

1. **数据持久化**: 数据存储在 Docker 卷中，删除容器不会删除数据
2. **端口冲突**: 确保 8080、28015、29015 端口未被占用
3. **内存使用**: `--cache-size` 参数限制内存使用（MB），但实际使用可能略高
4. **网络访问**: 默认绑定到所有接口（`--bind all`），生产环境建议限制访问

