# STF scrcpy H.264 支持 - 完整测试指南

## ✅ 已完成的工作

### 后端支持（已完成）
- ✅ scrcpy-server v3.3.3 集成
- ✅ H.264 视频流接收
- ✅ WebSocket 数据广播
- ✅ 详细调试日志

### 前端支持（刚完成）
- ✅ JSMpeg H.264 解码库
- ✅ H.264 渲染器模块
- ✅ 流类型自动检测
- ✅ 双模式兼容（JPEG/H.264）

## 📋 当前状态

**STF 正在运行**: `http://172.27.1.6:7100`

**关键文件**:
```
/opt/pkg/stf/res/app/components/stf/screen/
├── jsmpeg.min.js          (136KB - JSMpeg 解码库)
├── h264-renderer.js       (5KB - H.264 渲染器)
├── stream-type-detector.js (3KB - 类型检测)
└── screen-directive.js    (已修改 - 添加H.264支持)

/opt/pkg/stf/lib/units/device/resources/
├── scrcpy.js              (已完善 - 详细日志)
└── scrcpy-server.jar      (90KB - v3.3.3)
```

## 🧪 测试步骤

### 步骤 1: 打开浏览器
```
http://172.27.1.6:7100
```

### 步骤 2: 打开浏览器开发者工具
- 按 F12
- 切换到 Console 标签

### 步骤 3: 连接设备
- 选择设备 ZT322BPBXF
- 点击 "Use"

### 步骤 4: 观察日志

**后端日志** (STF terminal)：
```
INF Starting scrcpy for device ZT322BPBXF
INF Pushing scrcpy-server.jar to device
INF Scrcpy server pushed successfully
INF Starting scrcpy server on device
INF Scrcpy server started
INF Connecting to scrcpy server
INF Connected to scrcpy server
INF [DATA #1] Received 69 bytes
INF [DEVICE INFO] Name: moto g22, Size: 272x600
INF Scrcpy started successfully
INF [VIDEO DATA] Emitting video data: XXXX bytes
INF [STREAM] Broadcasting to 1 clients
```

**前端日志** (浏览器 Console)：
```
[Screen] Detected stream type: h264
[H264Renderer] Starting
[H264Renderer] Started successfully
```

### 步骤 5: 预期结果
- ✅ 屏幕显示实时视频（不是JPEG帧，而是连续视频）
- ✅ 触摸操作正常响应
- ✅ 按键操作正常响应
- ✅ 视频流畅

## 🔍 故障排除

### 问题 A: 浏览器白屏

**症状**: 页面加载后全白

**检查**:
```javascript
// 浏览器控制台查看
console.log('JSMpeg available:', typeof JSMpeg)
```

**解决**:
1. 确认 jsmpeg.min.js 加载成功
2. 检查网络请求（Network 标签）
3. 清除浏览器缓存

### 问题 B: "JSMpeg not available"

**症状**: 控制台报错 JSMpeg 未定义

**检查**:
```bash
curl -I http://localhost:7100/static/app/components/stf/screen/jsmpeg.min.js
```

**解决**:
确保 jsmpeg.min.js 在正确位置并可访问

### 问题 C: 检测为 JPEG 但应该是 H.264

**症状**: 日志显示 `Detected stream type: jpeg`

**原因**: 流类型检测失败

**解决**:
在浏览器控制台手动检查第一帧数据

### 问题 D: 视频不显示但无错误

**症状**: 控制台显示 H.264 renderer 启动，但canvas 无内容

**检查**: 查看 JSMpeg 内部错误
```javascript
// 检查 player 状态
```

**可能原因**:
1. H.264 数据格式不正确
2. JSMpeg 解码失败
3. Canvas 未正确初始化

### 问题 E: 屏幕卡顿或延迟

**解决**:
1. 降低 bitrate（在 scrcpy.js 中修改）
2. 检查网络延迟
3. 关闭浏览器开发者工具（减少内存占用）

## 📊 调试命令

### 后端日志过滤
```bash
# 查看 scrcpy 相关日志
tail -f /tmp/stf-startup.log | grep -E "scrcpy|VIDEO|STREAM"

# 查看设备 logcat
adb -s ZT322BPBXF logcat -s scrcpy:*
```

### 前端调试
```javascript
// 浏览器控制台

// 1. 检查 JSMpeg
console.log('JSMpeg:', typeof JSMpeg)

// 2. 检查渲染器状态
angular.element(document.querySelector('device-screen')).scope()

// 3. 查看 WebSocket 连接
console.log('WebSocket state:', ws.readyState)
```

## 🎯 成功标志

看到以下日志说明成功：

**后端**:
```
[STREAM] Received video-data event #N
[STREAM] Broadcasting to 1 clients
```

**前端**:
```
[Screen] Detected stream type: h264
[H264Renderer] JSMpeg player created successfully
```

**浏览器**:
- 屏幕显示流畅视频
- 操作响应正常

## 📝 技术细节

### 数据流
```
scrcpy server (device) 
  → H.264 NAL units
  → adb forward (tcp:8099)
  → STF scrcpy.js (socket.on('data'))
  → WebSocket broadcast
  → Browser
  → JSMpeg decoder
  → Canvas
```

### 关键参数
- **Max size**: 600px
- **Bitrate**: 8000000 (8 Mbps)
- **Audio**: false (禁用)
- **Control**: false (由STF处理)

