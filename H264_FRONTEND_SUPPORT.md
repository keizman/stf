# STF H.264 Frontend Support

## 概述

为 STF 添加了前端 H.264 视频解码支持，以兼容 scrcpy 的视频流。

## 新增文件

### 1. `/res/app/components/stf/screen/jsmpeg.min.js`
- JSMpeg H.264 解码库
- 用于在浏览器中实时解码 H.264 视频流
- 来源: https://github.com/phoboslab/jsmpeg

### 2. `/res/app/components/stf/screen/h264-renderer.js`
- **独立的 H.264 渲染器模块**
- 封装了 JSMpeg 的使用
- 提供简单的 API: `start()`, `stop()`, `processData()`
- 与原始 JPEG 渲染逻辑完全分离

### 3. `/res/app/components/stf/screen/stream-type-detector.js`
- **流类型检测模块**
- 自动检测 WebSocket 数据是 JPEG 还是 H.264
- 检测逻辑：
  - JPEG: 魔术字节 `0xFF 0xD8`
  - H.264: NAL 单元起始码 `0x00 0x00 0x00 0x01` 或 `0x00 0x00 0x01`

## 修改文件

### `/res/app/components/stf/screen/screen-directive.js`
**最小化修改，保持向后兼容**

添加的内容：
```javascript
// 1. 导入新模块
var StreamTypeDetector = require('./stream-type-detector')
var H264RendererFactory = require('./h264-renderer')

// 2. 在 messageListener 中添加类型检测和分发
if (!scope.streamType) {
  scope.streamType = StreamTypeDetector.detectType(message.data)
  
  if (scope.streamType === 'h264') {
    scope.h264Renderer = h264RendererFactory.create(canvas, {})
    scope.h264Renderer.start()
  }
}

// 3. 根据类型路由到不同渲染器
if (scope.streamType === 'h264' && scope.h264Renderer) {
  scope.h264Renderer.processData(message.data)  // H.264 路径
} else {
  // 原始 JPEG 渲染逻辑保持不变
}

// 4. 清理时停止 H.264 渲染器
if (scope.h264Renderer) {
  scope.h264Renderer.stop()
}
```

### `/res/app/views/index.pug`
添加 JSMpeg 脚本标签：
```pug
script(src='/static/app/components/stf/screen/jsmpeg.min.js')
```

## 工作原理

1. **自动检测**: 当接收到第一帧数据时，自动检测是 JPEG 还是 H.264
2. **动态初始化**: 如果检测到 H.264，初始化 H.264 渲染器
3. **智能路由**: 根据检测结果将数据发送到对应的渲染器
4. **向后兼容**: JPEG 流（minicap）继续使用原有的渲染逻辑，完全不受影响

## 使用方法

### 启动 STF with scrcpy
```bash
cd /opt/pkg/stf
export ALLOW_OUTDATED_DEPENDENCIES=1
stf local --need-scrcpy --public-ip 172.27.1.6
```

### 启动 STF with minicap (默认)
```bash
stf local --public-ip 172.27.1.6
```

两种模式都能正常工作，前端会自动检测并使用正确的渲染器。

## 技术细节

### H.264 数据流
- scrcpy 发送原始 H.264 NAL 单元
- JSMpeg 实时解码并渲染到 Canvas
- 支持硬件加速（WebGL）

### JPEG 数据流
- minicap 发送 JPEG 图片序列
- 使用 Image 对象加载和显示
- 原有逻辑保持不变

### 性能优化
- H.264 比 JPEG 序列占用更少带宽
- JSMpeg 使用 WebAssembly 加速（如果可用）
- 自动管理视频缓冲区

## 故障排除

### 如果 H.264 视频不显示

1. **检查浏览器控制台**
   - 查找 `[H264Renderer]` 日志
   - 确认 JSMpeg 库已加载

2. **确认流类型检测**
   - 应该看到 `[Screen] Detected stream type: h264`
   - 如果检测错误，检查数据格式

3. **验证 scrcpy 正在运行**
   - STF 后端日志应显示 `[STREAM] Received video-data event`
   - 确认使用了 `--need-scrcpy` 参数

4. **浏览器兼容性**
   - 推荐使用现代浏览器（Chrome/Firefox/Edge）
   - 确保 JavaScript 已启用
   - 某些旧浏览器可能不支持 WebAssembly

## 架构设计

```
WebSocket (H.264) --> StreamTypeDetector --> H264Renderer --> JSMpeg --> Canvas
                                        \
WebSocket (JPEG) ---------------------> Original JPEG Renderer --> Canvas
```

**关键特性**:
- ✅ 模块化设计
- ✅ 与原代码分离
- ✅ 向后兼容
- ✅ 自动检测
- ✅ 零配置

## 文件大小

- `jsmpeg.min.js`: ~136 KB (压缩后)
- `h264-renderer.js`: ~5 KB
- `stream-type-detector.js`: ~3 KB
- **总增加**: ~144 KB

## 未来改进

1. 添加音频支持（scrcpy 支持音频流）
2. 支持更多视频编码格式
3. 添加性能监控和统计
4. 优化缓冲区管理

## 维护注意事项

- **不要修改** `jsmpeg.min.js`（使用上游版本）
- **独立维护** H.264 相关模块
- **保持兼容** JPEG 渲染逻辑
- **测试两种模式** 在发布前

