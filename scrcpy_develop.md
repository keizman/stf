# STF Scrcpy Integration Development Notes

## Overview

Integrate scrcpy H.264 streaming into STF as an alternative to minicap JPEG streaming.

**Goal**: Add `--need-scrcpy` parameter to enable high-quality H.264 video display.

---

## Architecture

```
[Android Device]
    |
    v
[scrcpy-server.jar] --> Raw H.264 stream
    |
    v (adb forward)
[STF Backend: scrcpy-stream.js] --> WebSocket
    |
    v
[STF Frontend: h264-renderer.js] --> Canvas display
```

---

## Completed Work

### 1. Backend Implementation

**Files Modified/Created:**
- `lib/cli/local/index.js` - Added `--need-scrcpy` CLI option
- `lib/cli/provider/index.js` - Pass option to device worker
- `lib/cli/device/index.js` - Pass option to device unit
- `lib/units/device/index.js` - Conditional load scrcpy-stream or stream
- `lib/units/device/resources/scrcpy.js` - Scrcpy client (push jar, start server, forward port)
- `lib/units/device/plugins/screen/scrcpy-stream.js` - WebSocket server for H.264 broadcast

**Key Issues Resolved:**

| Issue | Solution |
|-------|----------|
| `Unknown argument: need-scrcpy` | Add option definition to all CLI entry points |
| `EADDRINUSE port 7400` | Conditional WebSocket server creation based on needScrcpy |
| `scrcpy.ScrcpyClient is not a constructor` | Fix syrup dependency injection order |
| `adb.getDevice is not a function` | Use `adb.push(serial, ...)` instead of `adb.getDevice(serial).push(...)` |
| `Expecting 5 parameters` (scrcpy v1.x) | Update to scrcpy v2.4 command format with named parameters |
| Wrong resolution `26674x13876` | Fix header parsing: 77 bytes (dummy:1 + name:64 + codec:4 + width:4 + height:4) |

### 2. Frontend Implementation

**Files Modified/Created:**
- `res/app/components/stf/screen/h264-renderer.js` - H.264 decoder and renderer
- `res/app/components/stf/screen/stream-type-detector.js` - Detect JPEG vs H.264
- `res/app/components/stf/screen/screen-directive.js` - Integrate H.264 renderer

---

## Web H.264 Decoding Solutions

### Solution A: WebCodecs API (Current Implementation)

**Pros:**
- Hardware-accelerated decoding
- Native browser API
- Best performance

**Cons:**
- Requires secure context (HTTPS or localhost)
- Not available over HTTP

**Workaround for HTTP:**
1. Open `chrome://flags`
2. Search "Insecure origins treated as secure"
3. Add STF URL (e.g., `http://172.27.1.6:7100`)
4. Restart Chrome

### Solution B: Broadway.js / JMuxer (Alternative)

**Broadway.js:**
- Pure JavaScript H.264 decoder
- Works over HTTP
- No external dependencies

**JMuxer:**
- Uses Media Source Extensions
- Requires `npm install jmuxer`

**Integration Issue:**
```
webpack compile error: Cannot resolve module 'stream'
```
JMuxer depends on Node.js built-in modules not available in browser.

**Status:** Not integrated. Requires webpack polyfill configuration or alternative bundling.

### Browser Compatibility

| Browser | WebCodecs | Notes |
|---------|-----------|-------|
| Chrome 94+ | Yes | Requires HTTPS or Flag |
| Edge 94+ | Yes | Same as Chrome |
| Firefox | No | Experimental, incomplete |
| Safari 16.4+ | Partial | Limited support |

**Recommendation:** Use Chrome with HTTP + Flag for development.

---

## Known Issues

### 1. Screen Tearing on Fullscreen Video

**Symptom:** Corrupted display when playing fullscreen video on device

**Cause:** Resolution change (portrait to landscape) causes decoder state mismatch

**Fix Applied:**
- Reset decoder on SPS change
- Use incremental timestamps instead of `performance.now()`
- Limit pending frames to prevent queue overflow

### 2. Canvas Size Mismatch

**Symptom:** Video displayed in small area, not filling container

**Cause:** Canvas using incorrect dimensions (clientWidth/Height before CSS applied)

**Fix Applied:**
- Get container size from parent `device-screen` element
- Set minimum size fallback (360x640)

### 3. Touch Coordinate Offset

**Symptom:** Touch events not mapping correctly to device

**Analysis:** ScalingService.coords already handles letterbox offset calculation. Canvas must match container dimensions for correct mapping.

---

## Scrcpy Server Configuration

**Version:** 2.4

**Command:**
```
CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 2.4 \
  log_level=verbose \
  video=true \
  audio=false \
  control=false \
  max_size=0 \
  video_bit_rate=8000000 \
  max_fps=60 \
  tunnel_forward=true \
  send_frame_meta=false \
  send_dummy_byte=true
```

**Header Format (77 bytes):**
| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | Dummy byte |
| 1 | 64 | Device name (null-terminated) |
| 65 | 4 | Codec ID (0x68323634 = "h264") |
| 69 | 4 | Width (big-endian) |
| 73 | 4 | Height (big-endian) |

---

## Usage

```bash
# Start STF with scrcpy
stf local --need-scrcpy

# Or with full options
stf local \
  --adb-host 127.0.0.1 \
  --public-ip 172.27.1.6 \
  --provider-min-port 7400 \
  --provider-max-port 7500 \
  --need-scrcpy
```

---

## TODO

- [ ] Integrate Broadway.js for HTTP support without Chrome flags
- [ ] Add control channel for touch/key events via scrcpy (currently uses STF native)
- [ ] Support audio streaming
- [ ] Handle device reconnection gracefully
- [ ] Performance optimization for multiple devices

