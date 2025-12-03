# STF 用户管理脚本

## 快速创建单个用户

### 方法 1: 全局命令（推荐）

```bash
stf-create-user user@company.com "用户姓名"
```

### 方法 2: 直接运行脚本

```bash
cd /opt/pkg/stf
node scripts/create-user.js user@company.com "用户姓名"
```

### 示例

```bash
# 创建用户
stf-create-user zhang.san@example.com "张三"
stf-create-user li.si@example.com "李四"
stf-create-user admin@example.com "管理员"
```

## 批量创建用户

### 1. 创建用户列表文件

创建一个文本文件（如 `users.txt`），每行一个用户：

```
zhang.san@company.com,张三
li.si@company.com 李四
wang.wu@company.com,王五
```

支持两种分隔符：
- 逗号: `email,姓名`
- 空格: `email 姓名`

以 `#` 开头的行会被忽略（注释）

### 2. 运行批量创建

```bash
cd /opt/pkg/stf
node scripts/batch-create-users.js users.txt
```

或使用示例文件：

```bash
cd /opt/pkg/stf
node scripts/batch-create-users.js scripts/users-example.txt
```

## 使用 STF 内置命令

STF 也提供了生成测试用户的命令（用于开发测试）：

```bash
# 创建 1 个随机测试用户
stf generate-fake-user

# 创建 10 个随机测试用户
stf generate-fake-user --number 10
```

## 通过 API 创建用户

如果 STF 已经运行，也可以通过 API 创建：

```bash
# 获取访问令牌（需要管理员权限）
TOKEN="your-access-token"

# 创建用户
curl -X POST http://localhost:7100/api/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "new.user@company.com",
    "name": "新用户"
  }'
```

## 查看现有用户

```bash
# 通过 API 查看所有用户
curl -X GET http://localhost:7100/api/v1/users \
  -H "Authorization: Bearer $TOKEN"
```

## 注意事项

1. **邮箱唯一性**: 每个邮箱只能创建一次，重复创建会失败
2. **数据库连接**: 脚本需要能连接到 RethinkDB（默认 localhost:28015）
3. **权限**: 
   - 第一个创建的用户自动成为管理员 (ADMIN)
   - 后续创建的用户默认为普通用户 (USER)
4. **认证模式**: 这些脚本直接操作数据库，绕过认证系统

## 故障排除

### 错误: 无法连接到数据库

确保 RethinkDB 正在运行：

```bash
# Docker 方式
docker ps | grep rethinkdb

# 检查端口
netstat -tlnp | grep 28015
```

### 错误: 用户已存在

该邮箱已被注册，需要使用不同的邮箱地址

### 查看数据库中的用户

```bash
# 使用 RethinkDB 管理界面
# 访问 http://localhost:8080
# 或使用命令行
docker exec -it rethinkdb rethinkdb
```

