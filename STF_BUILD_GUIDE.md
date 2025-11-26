# STF 构建和开发指南

## STF 命令的来源

### 1. `stf` 命令的构成

`stf` 命令来自 `bin/stf` 文件，它是一个简单的 Node.js 脚本：

```javascript
#!/usr/bin/env -S node --no-deprecation
require('../lib/cli/please')
```

**命令流程**：
```
bin/stf 
  → lib/cli/please.js 
    → lib/cli/index.js 
      → lib/cli/local/index.js (或其他子命令)
```

### 2. 如何让 `stf` 命令可用

**方法一：使用 npm link（推荐）**
```bash
cd /opt/pkg/stf
npm link
```
这会在 `/usr/local/bin/stf` 创建一个符号链接指向 `bin/stf`

**方法二：手动创建符号链接**
```bash
sudo ln -sf /opt/pkg/stf/bin/stf /usr/local/bin/stf
```

**方法三：直接使用路径**
```bash
/opt/pkg/stf/bin/stf local
# 或
node /opt/pkg/stf/bin/stf local
```

## STF 代码结构

### 后端代码（`lib/` 目录）
- **位置**: `lib/**/*.js`
- **特点**: 纯 Node.js 代码，**不需要编译**
- **运行方式**: 直接通过 Node.js 解释执行
- **修改后**: 需要**重启服务**才能生效

### 前端代码（`res/` 目录）
- **位置**: `res/app/`, `res/auth/`, `res/common/` 等
- **特点**: AngularJS 应用，需要 **webpack 构建**
- **构建输出**: `res/build/` 目录
- **修改后**: 
  - 开发模式：webpack watch 模式**自动重新构建**
  - 生产模式：需要手动运行构建命令

## 构建流程

### 开发模式（`stf local`）

当运行 `stf local` 时：

1. **后端代码**：直接运行，无需构建
2. **前端代码**：使用 webpack 的 **watch 模式**自动构建
   - 修改 `res/` 下的文件后，webpack 会自动重新构建
   - 构建结果在内存中（MemoryFileSystem），不写入磁盘
   - 浏览器刷新即可看到更改

### 生产模式（需要预构建）

如果需要预构建前端资源：

```bash
cd /opt/pkg/stf

# 安装依赖（如果还没安装）
npm install

# 构建前端资源
gulp build
# 或
npm run prepare
```

这会：
1. 运行 `bower install` 安装前端依赖
2. 运行 `gulp build` 构建 webpack 资源
3. 编译 Pug 模板为 HTML
4. 处理其他资源文件

## 修改代码后的处理

### 修改后端代码（`lib/` 目录）

**不需要重新构建**，但需要**重启 STF 服务**：

```bash
# 停止当前运行的 STF
# Ctrl+C 或 kill 进程

# 重新启动
stf local --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
```

### 修改前端代码（`res/` 目录）

**开发模式**（`stf local`）：
- **不需要手动构建**
- webpack watch 模式会自动检测更改并重新构建
- 浏览器刷新即可看到更改

**生产模式**（如果使用预构建）：
```bash
# 重新构建前端资源
gulp build

# 重启 STF
stf local ...
```

### 修改配置文件

- `package.json` - 需要运行 `npm install`
- `webpack.config.js` - 需要重启 STF（开发模式会自动重新加载）
- `gulpfile.js` - 需要重新运行 gulp 任务

## 常用构建命令

### 检查代码质量

```bash
# ESLint 检查
gulp eslint

# JSON 格式检查
gulp jsonlint
```

### 构建前端资源

```bash
# 构建 webpack 资源（生产模式）
gulp webpack:build

# 构建所有资源（包括 Pug 模板等）
gulp build
```

### 运行测试

```bash
# 单元测试（Karma）
gulp karma

# E2E 测试（Protractor）
gulp protractor
```

## 开发工作流

### 推荐开发流程

1. **启动开发环境**
   ```bash
   cd /opt/pkg/stf
   export ALLOW_OUTDATED_DEPENDENCIES=1
   export RETHINKDB_PORT_28015_TCP=tcp://localhost:28015
   stf local --adb-host adb --public-ip 172.27.1.6 --provider-min-port 7400 --provider-max-port 7500
   ```

2. **修改后端代码**（`lib/`）
   - 保存文件
   - 重启 STF 服务（Ctrl+C 然后重新运行）

3. **修改前端代码**（`res/`）
   - 保存文件
   - webpack 自动重新构建
   - 浏览器刷新查看更改

4. **查看构建日志**
   - webpack 构建信息会显示在 STF 启动日志中
   - 注意查看是否有错误或警告

## 常见问题

### Q: 修改了 JS 文件但没生效？

**后端代码**（`lib/`）：
- 确保已重启 STF 服务
- 检查是否有语法错误（查看启动日志）

**前端代码**（`res/`）：
- 检查 webpack 是否检测到更改（查看日志）
- 尝试硬刷新浏览器（Ctrl+Shift+R）
- 检查浏览器控制台是否有错误

### Q: webpack 构建失败？

```bash
# 清理构建缓存
rm -rf res/build
rm -rf node_modules/.cache

# 重新安装依赖
rm -rf node_modules
npm install

# 重新构建
gulp build
```

### Q: 如何禁用 webpack watch 模式？

修改 `lib/units/app/middleware/webpack.js` 或使用生产模式（预构建资源）。

### Q: 如何查看 webpack 配置？

查看 `webpack.config.js` 文件，了解构建配置和入口点。

## 总结

- **`stf` 命令**：来自 `bin/stf`，只是一个 Node.js 脚本入口
- **后端代码**（`lib/`）：不需要构建，修改后重启服务即可
- **前端代码**（`res/`）：开发模式自动构建，生产模式需要 `gulp build`
- **修改代码后**：
  - 后端：重启 STF
  - 前端：开发模式自动，生产模式需要重新构建

