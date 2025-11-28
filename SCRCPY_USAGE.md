# STF Scrcpy 支持使用说明

## 功能说明

STF 现在支持使用 scrcpy 作为屏幕流传输方式，替代默认的 minicap。

### scrcpy 优势
- 更高质量的 H.264 视频流
- 更低的延迟
- 更好的性能
- 支持 Android 5.0+ 所有设备

## 使用方法

### 1. 启动 STF 时启用 scrcpy

**使用 provider 模式**:
```bash
stf provider --need-scrcpy
```

**使用 local 模式**:
```bash
stf local --need-scrcpy
```

**使用 device 模式**:
```bash
stf device --serial <SERIAL> --need-scrcpy
```

### 2. 完整示例

```bash
# Local 模式
cd /opt/pkg/stf
export ALLOW_OUTDATED_DEPENDENCIES=1
stf local \
  --adb-host 127.0.0.1 \
  --public-ip 172.27.1.6 \
  --provider-min-port 7400 \
  --provider-max-port 7500 \
  --need-scrcpy
```

```bash
# Provider 模式
stf provider \
  --name my-provider \
  --connect-sub tcp://127.0.0.1:7114 \
  --connect-push tcp://127.0.0.1:7116 \
  --storage-url http://localhost:7100/ \
  --public-ip 172.27.1.6 \
  --min-port 7400 \
  --max-port 7500 \
  --heartbeat-interval 10000 \
  --screen-ws-url-pattern "ws://172.27.1.6:7402" \
  --need-scrcpy
```

## 工作原理

### 启用 scrcpy 后的流程

1. **服务器端**:
   - 推送 scrcpy-server.jar 到设备
   - 启动 scrcpy server
   - 创建端口转发 (localabstract:scrcpy)
   - 连接到 scrcpy server
   - 读取 H.264 视频流

2. **传输层**:
   - 通过 WebSocket 传输视频数据到浏览器
   - 保持与 minicap 相同的 WebSocket 协议

3. **浏览器端**:
   - 接收 H.264 视频流
   - 解码并显示 (透明处理，无需修改前端)

## 架构对比

### 使用 minicap (默认)
```
设备 -> minicap -> JPEG frames -> WebSocket -> 浏览器
```

### 使用 scrcpy
```
设备 -> scrcpy-server -> H.264 stream -> WebSocket -> 浏览器
```

## 文件结构

新增的文件：
```
stf/
├── lib/
│   └── units/
│       └── device/
│           ├── resources/
│           │   ├── scrcpy.js              # scrcpy 资源模块
│           │   └── scrcpy-server.jar      # scrcpy 服务器
│           └── plugins/
│               └── screen/
│                   └── stream.js          # 修改：支持 scrcpy 模式
├── lib/cli/
│   ├── device/index.js                    # 修改：添加 --need-scrcpy 参数
│   ├── provider/index.js                  # 修改：添加 --need-scrcpy 参数
│   └── local/index.js                     # 修改：添加 --need-scrcpy 参数
└── SCRCPY_USAGE.md                        # 本文件
```

## 注意事项

1. **兼容性**: scrcpy 需要 Android 5.0 (API 21) 及以上版本
2. **性能**: scrcpy 使用 H.264 编码，对设备和服务器的 CPU 有一定要求
3. **网络**: H.264 流传输需要更好的网络带宽
4. **并存**: 可以在不同设备上使用不同的模式（部分 minicap，部分 scrcpy）

## 故障排查

### 问题: scrcpy 无法启动

**检查**:
```bash
# 1. 检查设备 Android 版本
adb -s <serial> shell getprop ro.build.version.sdk

# 2. 检查 scrcpy-server.jar 是否存在
ls -la /opt/pkg/stf/lib/units/device/resources/scrcpy-server.jar

# 3. 检查设备上的文件
adb -s <serial> shell ls -la /data/local/tmp/scrcpy-server.jar
```

### 问题: 视频流中断

**解决**:
1. 检查网络连接
2. 查看 STF 日志: `device:resources:scrcpy`
3. 检查设备 logcat

### 问题: 黑屏或无画面

**可能原因**:
1. scrcpy server 未正常启动
2. 端口转发失败
3. 设备处于锁屏状态

**解决**:
```bash
# 手动测试 scrcpy
adb -s <serial> forward tcp:8099 localabstract:scrcpy
# 查看是否有错误
```

## 性能调优

### 调整参数

在 `scrcpy.js` 中可以修改配置：
```javascript
{
  maxSize: 600,      // 最大分辨率 (像素)
  bitrate: 8000000   // 比特率 (8 Mbps)
}
```

### 建议配置

- **高性能网络**: `bitrate: 16000000`, `maxSize: 1920`
- **一般网络**: `bitrate: 8000000`, `maxSize: 1080`
- **低带宽网络**: `bitrate: 4000000`, `maxSize: 720`

## 日志

查看 scrcpy 相关日志：
```bash
# 在 STF 日志中搜索
grep "device:resources:scrcpy" stf.log
grep "Scrcpy" stf.log
```

日志级别：
- `INFO`: 正常启动和停止消息
- `ERROR`: 启动失败、连接错误
- `WARN`: 非致命错误

## 切换回 minicap

如果需要切回 minicap，只需去掉 `--need-scrcpy` 参数：

```bash
stf local --adb-host 127.0.0.1 --public-ip 172.27.1.6
```

## 技术细节

### 端口使用
- scrcpy 使用端口 8099 (可配置)
- 与 minicap 的端口使用不冲突
- 端口转发在服务器本地 (127.0.0.1)

### 数据格式
- scrcpy 输出原始 H.264 NAL units
- 通过 WebSocket binary 传输
- 浏览器需要支持 H.264 解码

### 生命周期
1. 客户端连接 -> 启动 scrcpy
2. 客户端断开 -> 停止 scrcpy
3. 设备释放 -> 清理资源

## 参考资料

- [scrcpy GitHub](https://github.com/Genymobile/scrcpy)
- [STF Documentation](https://github.com/DeviceFarmer/stf)
- [H.264 Specification](https://www.itu.int/rec/T-REC-H.264)
