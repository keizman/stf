/**
 * H.264 Renderer for scrcpy stream
 * Uses WebCodecs API for hardware-accelerated decoding
 * Renders to canvas while maintaining aspect ratio
 */

console.log('[H264Renderer] Module loaded')

/**
 * H.264 NAL Unit parser - improved version
 */
function H264Parser() {
  this.buffer = new Uint8Array(0)
  this.frameCount = 0
}

H264Parser.prototype.push = function(data) {
  // Limit buffer size to prevent memory issues
  if (this.buffer.length > 1024 * 1024 * 5) { // 5MB max
    console.warn('[H264Parser] Buffer too large, clearing')
    this.buffer = new Uint8Array(0)
  }
  
  var newBuffer = new Uint8Array(this.buffer.length + data.length)
  newBuffer.set(this.buffer)
  newBuffer.set(data, this.buffer.length)
  this.buffer = newBuffer
}

H264Parser.prototype.clear = function() {
  this.buffer = new Uint8Array(0)
}

H264Parser.prototype.extractNALUnits = function() {
  var nalUnits = []
  var buffer = this.buffer
  var len = buffer.length
  var start = -1
  var i = 0

  // Find NAL unit boundaries
  while (i < len - 3) {
    // Check for start code (0x000001 or 0x00000001)
    if (buffer[i] === 0 && buffer[i + 1] === 0) {
      var startCodeLen = 0
      if (buffer[i + 2] === 1) {
        startCodeLen = 3
      } else if (buffer[i + 2] === 0 && i + 3 < len && buffer[i + 3] === 1) {
        startCodeLen = 4
      }
      
      if (startCodeLen > 0) {
        if (start >= 0) {
          // Found end of previous NAL unit
          nalUnits.push(buffer.slice(start, i))
        }
        start = i
        i += startCodeLen
        continue
      }
    }
    i++
  }

  // Keep remaining data in buffer (incomplete NAL unit)
  if (start >= 0) {
    this.buffer = buffer.slice(start)
  } else if (len > 0) {
    // No start code found, might be continuation
    this.buffer = buffer
  }

  return nalUnits
}

function getNALType(nalUnit) {
  var offset = 0
  if (nalUnit.length > 4 && nalUnit[0] === 0 && nalUnit[1] === 0 && nalUnit[2] === 0 && nalUnit[3] === 1) {
    offset = 4
  } else if (nalUnit.length > 3 && nalUnit[0] === 0 && nalUnit[1] === 0 && nalUnit[2] === 1) {
    offset = 3
  }
  if (offset >= nalUnit.length) return -1
  return nalUnit[offset] & 0x1f
}

/**
 * WebCodecs-based H.264 Renderer
 */
function WebCodecsRenderer(canvas) {
  this.canvas = canvas
  this.ctx = canvas.getContext('2d')
  
  // Offscreen canvas for full-resolution decoding
  this.offscreenCanvas = document.createElement('canvas')
  this.offscreenCtx = this.offscreenCanvas.getContext('2d')
  
  this.decoder = null
  this.parser = new H264Parser()
  this.isConfigured = false
  
  // Video dimensions (native resolution)
  this.videoWidth = 0
  this.videoHeight = 0
  this.configuredWidth = 0
  this.configuredHeight = 0
  
  this.sps = null
  this.pps = null
  this.running = false
  this.dataCount = 0
  this.frameTimestamp = 0
  this.pendingFrames = 0
}

WebCodecsRenderer.prototype.start = function() {
  var self = this
  this.running = true
  this._createDecoder()
  return true
}

WebCodecsRenderer.prototype._createDecoder = function() {
  var self = this
  
  if (this.decoder) {
    try { this.decoder.close() } catch (e) {}
  }
  
  try {
    this.decoder = new VideoDecoder({
      output: function(frame) {
        self.pendingFrames--
        self._renderFrame(frame)
      },
      error: function(e) {
        console.error('[WebCodecs] Decoder error:', e)
        // Try to recover
        self.isConfigured = false
        self.sps = null
        self.pps = null
        self.parser.clear()
      }
    })
    console.log('[WebCodecs] Decoder created')
    this.isConfigured = false
    return true
  } catch (e) {
    console.error('[WebCodecs] Failed to create decoder:', e)
    return false
  }
}

WebCodecsRenderer.prototype.stop = function() {
  this.running = false
  if (this.decoder) {
    try { this.decoder.close() } catch (e) {}
    this.decoder = null
  }
  this.isConfigured = false
  this.sps = null
  this.pps = null
  this.parser.clear()
}

WebCodecsRenderer.prototype.setSize = function(width, height) {
  this.videoWidth = width
  this.videoHeight = height
  console.log('[WebCodecs] Video size set:', width, 'x', height)
}

WebCodecsRenderer.prototype.getVideoDimensions = function() {
  return {
    width: this.videoWidth,
    height: this.videoHeight
  }
}

WebCodecsRenderer.prototype.configure = function(width, height, sps, pps) {
  // Check if we need to recreate decoder
  if (!this.decoder || this.decoder.state === 'closed') {
    console.log('[WebCodecs] Decoder missing or closed, recreating...')
    this._createDecoder()
    if (!this.decoder) return
  }

  // Check if reconfiguration is needed
  if (this.isConfigured && 
      this.configuredWidth === width && 
      this.configuredHeight === height) {
    return
  }

  console.log('[WebCodecs] Configuring decoder:', width, 'x', height)

  this.videoWidth = width
  this.videoHeight = height
  this.configuredWidth = width
  this.configuredHeight = height
  this.sps = sps
  this.pps = pps

  // Set offscreen canvas to full video resolution
  this.offscreenCanvas.width = width
  this.offscreenCanvas.height = height

  var config = this._buildAVCConfig(sps, pps)
  if (!config) {
    console.error('[WebCodecs] Failed to build avcC config')
    return
  }

  try {
    // Reset decoder if already configured
    if (this.decoder.state === 'configured') {
      this.decoder.reset()
    }
    
    // Build codec string from SPS profile
    var spsOffset = 0
    if (sps.length > 4 && sps[0] === 0 && sps[1] === 0 && sps[2] === 0 && sps[3] === 1) {
      spsOffset = 4
    } else if (sps.length > 3 && sps[0] === 0 && sps[1] === 0 && sps[2] === 1) {
      spsOffset = 3
    }
    var profile = sps[spsOffset + 1]
    var compat = sps[spsOffset + 2]
    var level = sps[spsOffset + 3]
    
    // Format as hex with leading zeros
    function toHex(n) {
      var hex = n.toString(16)
      return hex.length === 1 ? '0' + hex : hex
    }
    var codecString = 'avc1.' + toHex(profile) + toHex(compat) + toHex(level)
    
    console.log('[WebCodecs] Using codec:', codecString, 'profile:', profile, 'compat:', compat, 'level:', level)
    
    this.decoder.configure({
      codec: codecString,
      codedWidth: width,
      codedHeight: height,
      description: config,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true
    })
    
    this.isConfigured = true
    this.frameTimestamp = 0
    console.log('[WebCodecs] Configured successfully:', width, 'x', height)
  } catch (e) {
    console.error('[WebCodecs] Configure error:', e)
    this.isConfigured = false
    // Recreate decoder on error
    this._createDecoder()
  }
}

WebCodecsRenderer.prototype._buildAVCConfig = function(sps, pps) {
  // Find start code offset
  var spsOffset = 0
  if (sps.length > 4 && sps[0] === 0 && sps[1] === 0 && sps[2] === 0 && sps[3] === 1) {
    spsOffset = 4
  } else if (sps.length > 3 && sps[0] === 0 && sps[1] === 0 && sps[2] === 1) {
    spsOffset = 3
  }
  
  var ppsOffset = 0
  if (pps.length > 4 && pps[0] === 0 && pps[1] === 0 && pps[2] === 0 && pps[3] === 1) {
    ppsOffset = 4
  } else if (pps.length > 3 && pps[0] === 0 && pps[1] === 0 && pps[2] === 1) {
    ppsOffset = 3
  }
  
  var spsData = sps.slice(spsOffset)
  var ppsData = pps.slice(ppsOffset)
  
  // Validate SPS data
  if (spsData.length < 4) {
    console.error('[WebCodecs] Invalid SPS data length:', spsData.length)
    return null
  }
  
  // Check NAL type (should be 7 for SPS)
  var spsNalType = spsData[0] & 0x1f
  if (spsNalType !== 7) {
    console.warn('[WebCodecs] SPS NAL type mismatch:', spsNalType)
  }
  
  console.log('[WebCodecs] Building avcC: SPS len=' + spsData.length + ', PPS len=' + ppsData.length)
  console.log('[WebCodecs] SPS profile=' + spsData[1] + ', compat=' + spsData[2] + ', level=' + spsData[3])
  
  var config = new Uint8Array(11 + spsData.length + ppsData.length)
  var offset = 0

  config[offset++] = 1 // configurationVersion
  config[offset++] = spsData[1] // AVCProfileIndication
  config[offset++] = spsData[2] // profile_compatibility
  config[offset++] = spsData[3] // AVCLevelIndication
  config[offset++] = 0xff // lengthSizeMinusOne (3 = 4 bytes)
  config[offset++] = 0xe1 // numOfSequenceParameterSets
  
  config[offset++] = (spsData.length >> 8) & 0xff
  config[offset++] = spsData.length & 0xff
  config.set(spsData, offset)
  offset += spsData.length
  
  config[offset++] = 1 // numOfPictureParameterSets
  config[offset++] = (ppsData.length >> 8) & 0xff
  config[offset++] = ppsData.length & 0xff
  config.set(ppsData, offset)

  return config
}

WebCodecsRenderer.prototype.processData = function(data) {
  if (!this.running) return

  this.dataCount++
  var self = this

  if (data instanceof Blob) {
    var reader = new FileReader()
    reader.onload = function() {
      self._processArrayBuffer(new Uint8Array(reader.result))
    }
    reader.readAsArrayBuffer(data)
  } else if (data instanceof ArrayBuffer) {
    this._processArrayBuffer(new Uint8Array(data))
  } else if (data instanceof Uint8Array) {
    this._processArrayBuffer(data)
  }
}

WebCodecsRenderer.prototype._processArrayBuffer = function(data) {
  this.parser.push(data)
  var nalUnits = this.parser.extractNALUnits()
  
  for (var i = 0; i < nalUnits.length; i++) {
    this._processNALUnit(nalUnits[i])
  }
}

WebCodecsRenderer.prototype._processNALUnit = function(nalUnit) {
  var nalType = getNALType(nalUnit)
  if (nalType < 0) return

  switch (nalType) {
    case 7: // SPS
      this.sps = nalUnit
      // SPS changed, need to reconfigure
      this.isConfigured = false
      break
    case 8: // PPS
      this.pps = nalUnit
      if (this.sps && !this.isConfigured) {
        this._parseSPSAndConfigure()
      }
      break
    case 5: // IDR (keyframe)
    case 1: // Non-IDR
      if (this.isConfigured && this.decoder && this.decoder.state === 'configured') {
        this._decodeFrame(nalUnit, nalType === 5)
      }
      break
  }
}

WebCodecsRenderer.prototype._parseSPSAndConfigure = function() {
  // Parse SPS to get actual dimensions
  var width = this.videoWidth || 720
  var height = this.videoHeight || 1280
  
  // Try to parse dimensions from SPS
  try {
    var spsData = this.sps
    var offset = 0
    if (spsData[0] === 0 && spsData[1] === 0 && spsData[2] === 0 && spsData[3] === 1) {
      offset = 4
    } else if (spsData[0] === 0 && spsData[1] === 0 && spsData[2] === 1) {
      offset = 3
    }
    
    // Skip NAL header
    offset += 1
    
    // profile_idc
    var profileIdc = spsData[offset++]
    // constraint_set flags and reserved bits
    offset += 1
    // level_idc
    offset += 1
    
    // This is a simplified SPS parser - for complex cases, dimensions come from stream
  } catch (e) {
    // Use default dimensions
  }
  
  if (this.sps && this.pps) {
    this.configure(width, height, this.sps, this.pps)
  }
}

WebCodecsRenderer.prototype._decodeFrame = function(nalUnit, isKeyframe) {
  if (!this.decoder || this.decoder.state !== 'configured') return
  
  // Limit pending frames to prevent memory issues
  if (this.pendingFrames > 10) {
    return
  }

  // Find start code offset
  var startCodeOffset = 0
  if (nalUnit[0] === 0 && nalUnit[1] === 0 && nalUnit[2] === 0 && nalUnit[3] === 1) {
    startCodeOffset = 4
  } else if (nalUnit[0] === 0 && nalUnit[1] === 0 && nalUnit[2] === 1) {
    startCodeOffset = 3
  }

  var nalData = nalUnit.slice(startCodeOffset)
  
  // Convert to length-prefixed format (4 bytes)
  var lengthPrefixed = new Uint8Array(4 + nalData.length)
  lengthPrefixed[0] = (nalData.length >> 24) & 0xff
  lengthPrefixed[1] = (nalData.length >> 16) & 0xff
  lengthPrefixed[2] = (nalData.length >> 8) & 0xff
  lengthPrefixed[3] = nalData.length & 0xff
  lengthPrefixed.set(nalData, 4)

  try {
    this.frameTimestamp += 33333 // ~30fps in microseconds
    
    var chunk = new EncodedVideoChunk({
      type: isKeyframe ? 'key' : 'delta',
      timestamp: this.frameTimestamp,
      data: lengthPrefixed
    })
    
    this.pendingFrames++
    this.decoder.decode(chunk)
  } catch (e) {
    if (this.dataCount <= 10) {
      console.error('[WebCodecs] Decode error:', e)
    }
  }
}

WebCodecsRenderer.prototype._renderFrame = function(frame) {
  if (!this.running) {
    frame.close()
    return
  }

  var frameWidth = frame.displayWidth
  var frameHeight = frame.displayHeight

  // Check if resolution changed (e.g., screen rotation)
  if (this.configuredWidth !== frameWidth || this.configuredHeight !== frameHeight) {
    console.log('[WebCodecs] Resolution changed:', frameWidth, 'x', frameHeight)
    this.videoWidth = frameWidth
    this.videoHeight = frameHeight
    this.configuredWidth = frameWidth
    this.configuredHeight = frameHeight
    this.offscreenCanvas.width = frameWidth
    this.offscreenCanvas.height = frameHeight
  }

  // Draw to offscreen canvas at full resolution
  this.offscreenCtx.drawImage(frame, 0, 0)
  frame.close()

  // Get container size from parent element (device-screen)
  var parent = this.canvas.parentElement
  while (parent && parent.tagName !== 'DEVICE-SCREEN') {
    parent = parent.parentElement
  }
  
  var containerW, containerH
  if (parent) {
    containerW = parent.offsetWidth
    containerH = parent.offsetHeight
  } else {
    containerW = this.canvas.parentElement ? this.canvas.parentElement.offsetWidth : 360
    containerH = this.canvas.parentElement ? this.canvas.parentElement.offsetHeight : 640
  }

  if (containerW < 100) containerW = 360
  if (containerH < 100) containerH = 640

  // Set canvas to match container
  if (this.canvas.width !== containerW || this.canvas.height !== containerH) {
    this.canvas.width = containerW
    this.canvas.height = containerH
  }

  // Calculate scaled dimensions maintaining aspect ratio
  var videoAspect = frameWidth / frameHeight
  var containerAspect = containerW / containerH
  
  var drawW, drawH, offsetX, offsetY

  if (containerAspect > videoAspect) {
    drawH = containerH
    drawW = containerH * videoAspect
    offsetX = (containerW - drawW) / 2
    offsetY = 0
  } else {
    drawW = containerW
    drawH = containerW / videoAspect
    offsetX = 0
    offsetY = (containerH - drawH) / 2
  }

  // Clear and draw scaled frame
  this.ctx.fillStyle = '#1a1a1a'
  this.ctx.fillRect(0, 0, containerW, containerH)
  this.ctx.drawImage(
    this.offscreenCanvas,
    0, 0, frameWidth, frameHeight,
    offsetX, offsetY, drawW, drawH
  )
}

/**
 * Fallback renderer
 */
function FallbackRenderer(canvas) {
  this.canvas = canvas
  this.ctx = canvas.getContext('2d')
  this.videoWidth = 720
  this.videoHeight = 1280
  this.running = false
  this.dataCount = 0
}

FallbackRenderer.prototype.start = function() {
  this.running = true
  this._updateDisplay()
  return true
}

FallbackRenderer.prototype.stop = function() {
  this.running = false
}

FallbackRenderer.prototype.setSize = function(width, height) {
  this.videoWidth = width
  this.videoHeight = height
}

FallbackRenderer.prototype.getVideoDimensions = function() {
  return { width: this.videoWidth, height: this.videoHeight }
}

FallbackRenderer.prototype.processData = function(data) {
  this.dataCount++
  if (this.dataCount % 30 === 0) {
    this._updateDisplay()
  }
}

FallbackRenderer.prototype._updateDisplay = function() {
  if (!this.ctx) return
  
  var parent = this.canvas.parentElement
  while (parent && parent.tagName !== 'DEVICE-SCREEN') {
    parent = parent.parentElement
  }
  
  var containerW = parent ? parent.offsetWidth : 360
  var containerH = parent ? parent.offsetHeight : 640
  
  if (containerW < 100) containerW = 360
  if (containerH < 100) containerH = 640
  
  if (this.canvas.width !== containerW || this.canvas.height !== containerH) {
    this.canvas.width = containerW
    this.canvas.height = containerH
  }
  
  this.ctx.fillStyle = '#0a0a1a'
  this.ctx.fillRect(0, 0, containerW, containerH)
  
  this.ctx.fillStyle = '#00cc66'
  this.ctx.font = '14px monospace'
  this.ctx.textAlign = 'center'
  
  var msg = 'H.264 stream active\nFrames: ' + this.dataCount + 
    '\n\nWebCodecs requires HTTPS\n\nTo fix:\n1. chrome://flags\n2. "Insecure origins treated as secure"\n3. Add your STF URL'
  
  var lines = msg.split('\n')
  var y = containerH / 2 - (lines.length * 18) / 2
  for (var i = 0; i < lines.length; i++) {
    this.ctx.fillText(lines[i], containerW / 2, y + i * 20)
  }
}

/**
 * Factory
 * Returns WebCodecs renderer if available, null otherwise (to trigger minicap fallback)
 */
function H264RendererFactory($window) {
  var webCodecsSupported = typeof $window.VideoDecoder !== 'undefined'
  console.log('[H264Factory] WebCodecs supported:', webCodecsSupported)
  
  return {
    isSupported: function() { 
      return webCodecsSupported 
    },
    create: function(canvas) {
      if (webCodecsSupported) {
        console.log('[H264Factory] Using WebCodecs renderer')
        return new WebCodecsRenderer(canvas)
      } else {
        console.log('[H264Factory] WebCodecs not available, will fallback to minicap')
        return null  // Return null to signal fallback to minicap
      }
    }
  }
}

module.exports = H264RendererFactory
