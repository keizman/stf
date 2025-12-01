/**
 * H.264 Renderer for scrcpy stream
 * Uses JMuxer (MSE-based) as primary decoder
 * Falls back to Broadway.js for software decoding
 */

// Import JMuxer for MSE-based H.264 decoding
var JMuxer = require('jmuxer')
// Import Broadway Player as fallback
var Player = require('./broadway/Player')

console.log('[H264Renderer] Module loaded')
console.log('[H264Renderer] JMuxer available:', typeof JMuxer !== 'undefined')
console.log('[H264Renderer] Broadway Player available:', typeof Player !== 'undefined')

/**
 * JMuxer-based H.264 Renderer
 * Uses MSE (Media Source Extensions) for hardware-accelerated decoding
 */
function JMuxerRenderer(canvas) {
  this.canvas = canvas
  this.jmuxer = null
  this.video = null
  this.running = false
  this.ready = false
  this.dataCount = 0
  this.videoWidth = 720
  this.videoHeight = 1280
  this.frameCount = 0
  this.pendingData = []
  this.streamBuffer = new Uint8Array(0)  // Buffer for reassembling fragmented NAL units
}

JMuxerRenderer.prototype.start = function() {
  var self = this
  this.running = true
  this.ready = false
  this.pendingData = []
  this.dataCount = 0

  console.log('[JMuxer] Starting H.264 player')

  try {
    // Create video element
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.style.width = '100%'
    this.video.style.height = '100%'
    this.video.style.objectFit = 'contain'
    this.video.style.backgroundColor = '#0d0e1b'
    this.video.className = this.canvas.className

    // Replace canvas with video
    if (this.canvas.parentNode) {
      this.canvas.parentNode.replaceChild(this.video, this.canvas)
      console.log('[JMuxer] Replaced canvas with video element')
    }

    // Create JMuxer instance
    this.jmuxer = new JMuxer({
      node: this.video,
      mode: 'video',
      flushingTime: 0,
      fps: 60,
      debug: true,
      onReady: function() {
        console.log('[JMuxer] Ready!')
        self.ready = true
        self._processPendingData()
      },
      onError: function(err) {
        console.error('[JMuxer] Error:', err)
      }
    })

    console.log('[JMuxer] JMuxer created:', this.jmuxer)
    
    // JMuxer might be ready immediately for some configurations
    setTimeout(function() {
      if (!self.ready) {
        console.log('[JMuxer] Assuming ready after timeout')
        self.ready = true
        self._processPendingData()
      }
    }, 500)

    return true
  } catch (e) {
    console.error('[JMuxer] Failed to initialize:', e)
    return false
  }
}

JMuxerRenderer.prototype._processPendingData = function() {
  if (this.pendingData.length > 0) {
    console.log('[JMuxer] Processing', this.pendingData.length, 'pending data chunks')
    for (var i = 0; i < this.pendingData.length; i++) {
      this._feedData(this.pendingData[i])
    }
    this.pendingData = []
  }
}

JMuxerRenderer.prototype.stop = function() {
  this.running = false
  if (this.jmuxer) {
    this.jmuxer.destroy()
    this.jmuxer = null
  }
  console.log('[JMuxer] Stopped')
}

JMuxerRenderer.prototype.setSize = function(width, height) {
  this.videoWidth = width
  this.videoHeight = height
  console.log('[JMuxer] Video size set:', width, 'x', height)
}

JMuxerRenderer.prototype.getVideoDimensions = function() {
  return {
    width: this.videoWidth,
    height: this.videoHeight
  }
}

JMuxerRenderer.prototype.processData = function(data) {
  if (!this.running || !this.jmuxer) {
    return
  }

  this.dataCount++
  var self = this

  // Convert to Uint8Array
  if (data instanceof Blob) {
    var reader = new FileReader()
    reader.onload = function() {
      self._decodeData(new Uint8Array(reader.result))
    }
    reader.readAsArrayBuffer(data)
  } else if (data instanceof ArrayBuffer) {
    this._decodeData(new Uint8Array(data))
  } else if (data instanceof Uint8Array) {
    this._decodeData(data)
  }
}

JMuxerRenderer.prototype._decodeData = function(data) {
  if (!this.jmuxer) {
    console.warn('[JMuxer] No jmuxer available')
    return
  }

  if (this.dataCount <= 10) {
    console.log('[JMuxer] _decodeData called, data length:', data.length, 'ready:', this.ready,
      'first bytes:', Array.prototype.slice.call(data, 0, 8).join(','))
  }

  if (!this.ready) {
    this.pendingData.push(data)
    if (this.dataCount <= 10) {
      console.log('[JMuxer] Buffering data until ready, pending:', this.pendingData.length)
    }
    return
  }

  this._feedData(data)
}

JMuxerRenderer.prototype._feedData = function(data) {
  // Check if data starts with NAL start code
  var hasStartCode = data.length > 4 && data[0] === 0 && data[1] === 0 && 
                     ((data[2] === 0 && data[3] === 1) || data[2] === 1)
  
  if (hasStartCode) {
    // New NAL unit - first flush any buffered data
    if (this.streamBuffer.length > 0) {
      this._flushBuffer()
    }
    // Start buffering new NAL
    this.streamBuffer = new Uint8Array(data.length)
    this.streamBuffer.set(data)
  } else {
    // Continuation of previous NAL - append to buffer
    var newBuffer = new Uint8Array(this.streamBuffer.length + data.length)
    newBuffer.set(this.streamBuffer)
    newBuffer.set(data, this.streamBuffer.length)
    this.streamBuffer = newBuffer
  }
}

JMuxerRenderer.prototype._flushBuffer = function() {
  if (this.streamBuffer.length === 0) return
  
  try {
    this.jmuxer.feed({
      video: this.streamBuffer
    })
    this.frameCount++
  } catch (e) {
    // Ignore errors for incomplete NAL units
    if (this.dataCount <= 20) {
      console.warn('[JMuxer] Feed warning:', e.message || e)
    }
  }
  this.streamBuffer = new Uint8Array(0)
}

/**
 * Broadway-based H.264 Renderer
 * Pure JavaScript decoder - works without HTTPS
 */
function BroadwayRenderer(canvas) {
  this.canvas = canvas
  this.ctx = canvas.getContext('2d')
  this.player = null
  this.running = false
  this.ready = false
  this.dataCount = 0
  this.videoWidth = 720
  this.videoHeight = 1280
  this.frameCount = 0
  this.pendingData = []  // Buffer data until decoder is ready
  this.streamBuffer = new Uint8Array(0)  // Buffer for reassembling fragmented NAL units
}

BroadwayRenderer.prototype.start = function() {
  var self = this
  this.running = true
  this.ready = false
  this.pendingData = []
  
  console.log('[Broadway] Starting H.264 player')
  console.log('[Broadway] Player constructor:', typeof Player)
  
  try {
    // Create Broadway Player (handles WASM initialization internally)
    // Disable WebGL to avoid potential rendering issues
    this.player = new Player({
      useWorker: false,  // Don't use web worker for simpler debugging
      webgl: false,      // Use Canvas 2D instead of WebGL for better compatibility
      size: {
        width: this.videoWidth,
        height: this.videoHeight
      }
    })
    
    console.log('[Broadway] Player created')
    console.log('[Broadway] Player canvas:', this.player.canvas)
    console.log('[Broadway] Player webgl:', this.player.webgl)
    
    // Replace canvas with Broadway's canvas directly
    if (this.player.canvas && this.canvas.parentNode) {
      // Style Broadway's canvas to match our container
      this.player.canvas.style.width = '100%'
      this.player.canvas.style.height = '100%'
      this.player.canvas.style.objectFit = 'contain'
      this.player.canvas.className = this.canvas.className
      
      // Replace our canvas with Broadway's
      this.canvas.parentNode.replaceChild(this.player.canvas, this.canvas)
      this.canvas = this.player.canvas
      console.log('[Broadway] Replaced canvas with Broadway canvas')
    }
    
    // Set up frame callback - called after render is complete
    this.player.onRenderFrameComplete = function(info) {
      self.frameCount++
      if (self.frameCount <= 5) {
        console.log('[Broadway] Frame rendered:', info.width, 'x', info.height)
      }
    }
    
    // Also track decoded frames for debugging
    this.player.onPictureDecoded = function(buffer, width, height, infos) {
      self.frameCount++
      if (self.frameCount <= 5) {
        console.log('[Broadway] Frame decoded:', width, 'x', height, 'buffer:', buffer ? buffer.length : 0)
      }
    }
    
    // Wait for decoder to be ready (WASM loaded)
    // Broadway's decoder internally uses this callback
    if (this.player.decoder && typeof this.player.decoder.onDecoderReady === 'function') {
      var origReady = this.player.decoder.onDecoderReady
      this.player.decoder.onDecoderReady = function(decoder) {
        console.log('[Broadway] Decoder WASM ready!')
        console.log('[Broadway] Decoder streamBuffer:', decoder?.streamBuffer?.length)
        console.log('[Broadway] Decoder decode fn:', typeof decoder?.decode)
        self.ready = true
        origReady.apply(this, arguments)
        // Process any pending data
        self._processPendingData()
      }
    } else {
      // Assume ready after short delay if no callback available
      setTimeout(function() {
        console.log('[Broadway] Assuming decoder ready after timeout')
        self.ready = true
        self._processPendingData()
      }, 500)
    }
    
    console.log('[Broadway] Player initialized, waiting for WASM...')
    console.log('[Broadway] Player decoder:', this.player.decoder)
    console.log('[Broadway] Player decoder.decode:', typeof this.player.decoder?.decode)
    return true
  } catch (e) {
    console.error('[Broadway] Failed to initialize player:', e)
    return false
  }
}

BroadwayRenderer.prototype._processPendingData = function() {
  if (this.pendingData.length > 0) {
    console.log('[Broadway] Processing', this.pendingData.length, 'pending data chunks')
    for (var i = 0; i < this.pendingData.length; i++) {
      this._decodeDataInternal(this.pendingData[i])
    }
    this.pendingData = []
  }
}

BroadwayRenderer.prototype.stop = function() {
  this.running = false
  this.player = null
  console.log('[Broadway] Player stopped')
}

BroadwayRenderer.prototype.setSize = function(width, height) {
  this.videoWidth = width
  this.videoHeight = height
  console.log('[Broadway] Video size set:', width, 'x', height)
}

BroadwayRenderer.prototype.getVideoDimensions = function() {
  return {
    width: this.videoWidth,
    height: this.videoHeight
  }
}

BroadwayRenderer.prototype.processData = function(data) {
  if (!this.running || !this.player) {
    return
  }
  
  this.dataCount++
  var self = this
  
  // Convert to Uint8Array
  if (data instanceof Blob) {
    var reader = new FileReader()
    reader.onload = function() {
      self._decodeData(new Uint8Array(reader.result))
    }
    reader.readAsArrayBuffer(data)
  } else if (data instanceof ArrayBuffer) {
    this._decodeData(new Uint8Array(data))
  } else if (data instanceof Uint8Array) {
    this._decodeData(data)
  }
}

BroadwayRenderer.prototype._decodeData = function(data) {
  if (!this.player) {
    console.warn('[Broadway] No player available')
    return
  }
  
  if (this.dataCount <= 10) {
    console.log('[Broadway] _decodeData called, data length:', data.length, 'ready:', this.ready,
      'first bytes:', Array.prototype.slice.call(data, 0, 8).join(','))
  }
  
  if (!this.ready) {
    // Buffer data until decoder is ready
    this.pendingData.push(data)
    if (this.dataCount <= 10) {
      console.log('[Broadway] Buffering data until ready, pending:', this.pendingData.length)
    }
    return
  }
  
  this._decodeDataInternal(data)
}

BroadwayRenderer.prototype._decodeDataInternal = function(data) {
  try {
    var hasStartCode = data.length > 4 && data[0] === 0 && data[1] === 0 && 
                       ((data[2] === 0 && data[3] === 1) || data[2] === 1)
    
    if (this.dataCount <= 20) {
      console.log('[Broadway] Received chunk, size:', data.length, 'hasStartCode:', hasStartCode, 'buffer:', this.streamBuffer.length)
    }
    
    if (hasStartCode) {
      // New NAL unit starting - first decode any buffered data from previous NAL
      if (this.streamBuffer.length > 0) {
        this._flushBuffer()
      }
      // Start buffering new NAL
      this.streamBuffer = new Uint8Array(data.length)
      this.streamBuffer.set(data)
    } else {
      // Continuation of previous NAL - append to buffer
      var newBuffer = new Uint8Array(this.streamBuffer.length + data.length)
      newBuffer.set(this.streamBuffer)
      newBuffer.set(data, this.streamBuffer.length)
      this.streamBuffer = newBuffer
      if (this.dataCount <= 20) {
        console.log('[Broadway] Appended to buffer, new size:', this.streamBuffer.length)
      }
    }
  } catch (e) {
    console.error('[Broadway] Decode error:', e)
  }
}

BroadwayRenderer.prototype._flushBuffer = function() {
  if (this.streamBuffer.length === 0) return
  
  // Split buffer into individual NAL units and decode each separately
  var nalUnits = this._splitNALUnits(this.streamBuffer)
  
  if (this.dataCount <= 30) {
    console.log('[Broadway] Flushing buffer, size:', this.streamBuffer.length, 'contains', nalUnits.length, 'NAL(s)')
  }
  
  for (var i = 0; i < nalUnits.length; i++) {
    var nal = nalUnits[i]
    var nalType = this._getNALType(nal)
    if (this.dataCount <= 30) {
      console.log('[Broadway] Decoding NAL', i, 'type:', nalType, 'size:', nal.length, 'first 8 bytes:', Array.prototype.slice.call(nal, 0, 8))
    }
    try {
      this.player.decode(nal)
      if (this.dataCount <= 30) {
        console.log('[Broadway] decode() returned for NAL', i)
      }
    } catch (e) {
      console.error('[Broadway] decode() threw error:', e)
    }
  }
  
  this.streamBuffer = new Uint8Array(0)
}

BroadwayRenderer.prototype._extractCompleteNALUnits = function(data) {
  var nalUnits = []
  var startPositions = []
  var i = 0
  var len = data.length
  
  // Find all start code positions
  while (i < len - 3) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 0 && data[i + 3] === 1) {
        startPositions.push({ offset: i, len: 4 })
        i += 4
        continue
      } else if (data[i + 2] === 1) {
        startPositions.push({ offset: i, len: 3 })
        i += 3
        continue
      }
    }
    i++
  }
  
  // If we have multiple start codes, extract all NAL units
  // The last one is considered complete because we have data after it
  if (startPositions.length >= 2) {
    for (var j = 0; j < startPositions.length - 1; j++) {
      var start = startPositions[j].offset
      var end = startPositions[j + 1].offset
      nalUnits.push(data.slice(start, end))
    }
    // Keep the last NAL unit in buffer
    var lastStart = startPositions[startPositions.length - 1].offset
    return {
      nalUnits: nalUnits,
      remaining: data.slice(lastStart)
    }
  } else if (startPositions.length === 1) {
    // Single NAL unit - if buffer is getting large, assume it's complete and decode it
    if (data.length > 100000) {  // 100KB threshold
      return {
        nalUnits: [data],
        remaining: new Uint8Array(0)
      }
    }
    // Otherwise keep buffering
    return {
      nalUnits: [],
      remaining: data
    }
  } else {
    // No start code found - this is continuation data, keep buffering
    return {
      nalUnits: [],
      remaining: data
    }
  }
}

BroadwayRenderer.prototype._splitNALUnits = function(data) {
  var nalUnits = []
  var i = 0
  var len = data.length
  var lastStart = -1
  
  while (i < len - 3) {
    // Look for start code 0x00000001 or 0x000001
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 0 && data[i + 3] === 1) {
        // Found 0x00000001
        if (lastStart >= 0) {
          nalUnits.push(data.slice(lastStart, i))
        }
        lastStart = i
        i += 4
        continue
      } else if (data[i + 2] === 1) {
        // Found 0x000001
        if (lastStart >= 0) {
          nalUnits.push(data.slice(lastStart, i))
        }
        lastStart = i
        i += 3
        continue
      }
    }
    i++
  }
  
  // Add last NAL unit
  if (lastStart >= 0) {
    nalUnits.push(data.slice(lastStart))
  } else if (len > 0) {
    // No start code found, treat entire data as one NAL unit
    nalUnits.push(data)
  }
  
  return nalUnits
}

BroadwayRenderer.prototype._getNALType = function(data) {
  var offset = 0
  if (data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) {
    offset = 4
  } else if (data[0] === 0 && data[1] === 0 && data[2] === 1) {
    offset = 3
  }
  if (offset < data.length) {
    var type = data[offset] & 0x1f
    var typeName = {1: 'P-frame', 5: 'IDR', 7: 'SPS', 8: 'PPS'}[type] || 'type-' + type
    return typeName
  }
  return 'unknown'
}

BroadwayRenderer.prototype._updateDisplay = function(width, height) {
  // Broadway renders directly to its canvas, no need to copy
  // Just update video dimensions for coordinate mapping
  if (this.videoWidth !== width || this.videoHeight !== height) {
    this.videoWidth = width
    this.videoHeight = height
    console.log('[Broadway] Video dimensions updated:', width, 'x', height)
  }
}

/**
 * WebCodecs-based renderer (for HTTPS environments)
 */
function WebCodecsRenderer(canvas) {
  this.canvas = canvas
  this.ctx = canvas.getContext('2d')
  this.offscreenCanvas = document.createElement('canvas')
  this.offscreenCtx = this.offscreenCanvas.getContext('2d')
  this.decoder = null
  this.parser = new H264Parser()
  this.isConfigured = false
  this.videoWidth = 0
  this.videoHeight = 0
  this.sps = null
  this.pps = null
  this.running = false
  this.dataCount = 0
  this.frameTimestamp = 0
  this.pendingFrames = 0
}

function H264Parser() {
  this.buffer = new Uint8Array(0)
}

H264Parser.prototype.push = function(data) {
  if (this.buffer.length > 5 * 1024 * 1024) {
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

  while (i < len - 3) {
    if (buffer[i] === 0 && buffer[i + 1] === 0) {
      var startCodeLen = 0
      if (buffer[i + 2] === 1) {
        startCodeLen = 3
      } else if (buffer[i + 2] === 0 && i + 3 < len && buffer[i + 3] === 1) {
        startCodeLen = 4
      }
      
      if (startCodeLen > 0) {
        if (start >= 0) {
          nalUnits.push(buffer.slice(start, i))
        }
        start = i
        i += startCodeLen
        continue
      }
    }
    i++
  }

  if (start >= 0) {
    this.buffer = buffer.slice(start)
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

WebCodecsRenderer.prototype.start = function() {
  var self = this
  this.running = true
  return this._createDecoder()
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
        self.isConfigured = false
        self.parser.clear()
      }
    })
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
  this.parser.clear()
}

WebCodecsRenderer.prototype.setSize = function(width, height) {
  this.videoWidth = width
  this.videoHeight = height
}

WebCodecsRenderer.prototype.getVideoDimensions = function() {
  return { width: this.videoWidth, height: this.videoHeight }
}

WebCodecsRenderer.prototype.configure = function(width, height, sps, pps) {
  if (!this.decoder) return
  
  this.videoWidth = width
  this.videoHeight = height
  this.offscreenCanvas.width = width
  this.offscreenCanvas.height = height
  
  var spsOffset = (sps[0] === 0 && sps[1] === 0 && sps[2] === 0 && sps[3] === 1) ? 4 : 3
  var ppsOffset = (pps[0] === 0 && pps[1] === 0 && pps[2] === 0 && pps[3] === 1) ? 4 : 3
  var spsData = sps.slice(spsOffset)
  var ppsData = pps.slice(ppsOffset)
  
  var config = new Uint8Array(11 + spsData.length + ppsData.length)
  var offset = 0
  config[offset++] = 1
  config[offset++] = spsData[1]
  config[offset++] = spsData[2]
  config[offset++] = spsData[3]
  config[offset++] = 0xff
  config[offset++] = 0xe1
  config[offset++] = (spsData.length >> 8) & 0xff
  config[offset++] = spsData.length & 0xff
  config.set(spsData, offset)
  offset += spsData.length
  config[offset++] = 1
  config[offset++] = (ppsData.length >> 8) & 0xff
  config[offset++] = ppsData.length & 0xff
  config.set(ppsData, offset)

  try {
    if (this.decoder.state === 'configured') {
      this.decoder.reset()
    }
    this.decoder.configure({
      codec: 'avc1.42E01E',
      codedWidth: width,
      codedHeight: height,
      description: config,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true
    })
    this.isConfigured = true
    this.frameTimestamp = 0
  } catch (e) {
    console.error('[WebCodecs] Configure error:', e)
    this.isConfigured = false
  }
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
    case 7:
      this.sps = nalUnit
      this.isConfigured = false
      break
    case 8:
      this.pps = nalUnit
      if (this.sps && !this.isConfigured) {
        this.configure(this.videoWidth || 720, this.videoHeight || 1280, this.sps, this.pps)
      }
      break
    case 5:
    case 1:
      if (this.isConfigured && this.decoder && this.decoder.state === 'configured') {
        this._decodeFrame(nalUnit, nalType === 5)
      }
      break
  }
}

WebCodecsRenderer.prototype._decodeFrame = function(nalUnit, isKeyframe) {
  if (!this.decoder || this.decoder.state !== 'configured') return
  if (this.pendingFrames > 10) return

  var startCodeOffset = (nalUnit[0] === 0 && nalUnit[1] === 0 && nalUnit[2] === 0 && nalUnit[3] === 1) ? 4 : 3
  var nalData = nalUnit.slice(startCodeOffset)
  var lengthPrefixed = new Uint8Array(4 + nalData.length)
  lengthPrefixed[0] = (nalData.length >> 24) & 0xff
  lengthPrefixed[1] = (nalData.length >> 16) & 0xff
  lengthPrefixed[2] = (nalData.length >> 8) & 0xff
  lengthPrefixed[3] = nalData.length & 0xff
  lengthPrefixed.set(nalData, 4)

  try {
    this.frameTimestamp += 33333
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

  if (this.videoWidth !== frameWidth || this.videoHeight !== frameHeight) {
    this.videoWidth = frameWidth
    this.videoHeight = frameHeight
    this.offscreenCanvas.width = frameWidth
    this.offscreenCanvas.height = frameHeight
  }

  this.offscreenCtx.drawImage(frame, 0, 0)
  frame.close()

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

  this.ctx.fillStyle = '#1a1a1a'
  this.ctx.fillRect(0, 0, containerW, containerH)
  this.ctx.drawImage(this.offscreenCanvas, 0, 0, frameWidth, frameHeight, offsetX, offsetY, drawW, drawH)
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
  
  var msg = 'H.264 stream active\nFrames: ' + this.dataCount + '\n\nNo decoder available'
  var lines = msg.split('\n')
  var y = containerH / 2 - (lines.length * 18) / 2
  for (var i = 0; i < lines.length; i++) {
    this.ctx.fillText(lines[i], containerW / 2, y + i * 20)
  }
}

/**
 * Factory - chooses best available renderer
 * Priority: WebCodecs (if available) > JMuxer > Broadway > Fallback
 * 
 * Note: WebCodecs requires secure context (HTTPS or localhost), but Chrome's
 * "Insecure origins treated as secure" flag makes VideoDecoder available
 * even on HTTP. So we just check if VideoDecoder exists.
 */
function H264RendererFactory($window) {
  var jmuxerAvailable = typeof JMuxer !== 'undefined'
  var mseSupported = typeof $window.MediaSource !== 'undefined' && 
                     $window.MediaSource.isTypeSupported && 
                     $window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
  var webCodecsSupported = typeof $window.VideoDecoder !== 'undefined'
  var broadwayAvailable = typeof Player !== 'undefined'
  
  console.log('[H264Factory] WebCodecs supported:', webCodecsSupported)
  console.log('[H264Factory] JMuxer available:', jmuxerAvailable)
  console.log('[H264Factory] MSE H.264 supported:', mseSupported)
  console.log('[H264Factory] Broadway Player available:', broadwayAvailable)
  
  return {
    isSupported: function() {
      return webCodecsSupported || (jmuxerAvailable && mseSupported) || broadwayAvailable
    },
    create: function(canvas) {
      // Prefer WebCodecs if available (best performance, hardware accelerated)
      // WebCodecs will be available if:
      // 1. HTTPS or localhost
      // 2. HTTP with Chrome's "Insecure origins treated as secure" flag
      if (webCodecsSupported) {
        console.log('[H264Factory] Using WebCodecs renderer')
        return new WebCodecsRenderer(canvas)
      }
      // JMuxer (MSE-based, also hardware accelerated, works over HTTP)
      if (jmuxerAvailable && mseSupported) {
        console.log('[H264Factory] Using JMuxer renderer (MSE)')
        return new JMuxerRenderer(canvas)
      }
      // Fallback to Broadway (software decoding)
      if (broadwayAvailable) {
        console.log('[H264Factory] Using Broadway renderer')
        return new BroadwayRenderer(canvas)
      }
      // Last resort
      console.log('[H264Factory] Using Fallback renderer')
      return new FallbackRenderer(canvas)
    }
  }
}

module.exports = H264RendererFactory
