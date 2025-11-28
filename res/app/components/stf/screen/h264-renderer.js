/**
 * H.264 Video Stream Renderer for scrcpy
 * Uses JSMpeg to decode H.264 video in the browser
 */

module.exports = function H264RendererFactory($window) {
  'use strict'

  function hasWebCodecSupport(win) {
    return !!(win.VideoDecoder && win.EncodedVideoChunk)
  }

  function hasMediaSourceSupport(win) {
    return !!(win.MediaSource && typeof win.MediaSource === 'function')
  }

  function startCodeOffset(bytes, index) {
    if (index + 3 >= bytes.length) {
      return -1
    }
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      return index + 3
    }
    if (index + 4 < bytes.length &&
      bytes[index] === 0 && bytes[index + 1] === 0 &&
      bytes[index + 2] === 0 && bytes[index + 3] === 1) {
      return index + 4
    }
    return -1
  }

  function splitAnnexBNalus(bytes) {
    var units = []
    var start = -1
    var i = 0

    while (i < bytes.length) {
      var offset = startCodeOffset(bytes, i)
      if (offset !== -1) {
        if (start !== -1 && offset - start > 0) {
          units.push(bytes.subarray(start, i))
        }
        start = offset
        i = offset
        continue
      }
      i += 1
    }

    if (start !== -1 && start < bytes.length) {
      units.push(bytes.subarray(start))
    }

    return units
  }

  function splitLengthPrefixedNalus(bytes) {
    var units = []
    var offset = 0
    while (offset + 4 <= bytes.length) {
      var length = (
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        (bytes[offset + 3])
      ) >>> 0
      offset += 4
      if (length === 0 || offset + length > bytes.length) {
        break
      }
      units.push(bytes.subarray(offset, offset + length))
      offset += length
    }
    return units
  }

  function extractNalUnits(bytes) {
    var units = splitAnnexBNalus(bytes)
    if (units.length) {
      return units
    }
    return splitLengthPrefixedNalus(bytes)
  }

  function getNalType(unit) {
    if (!unit || !unit.length) {
      return -1
    }
    return unit[0] & 0x1F
  }

  function isParameterSet(type) {
    return type === 7 || type === 8
  }

  function containsIdr(nalUnits) {
    return nalUnits.some(function(unit) {
      return getNalType(unit) === 5
    })
  }

  function stripStartCode(unit) {
    if (!unit || !unit.length) {
      return unit
    }
    var offset = 0
    if (unit[0] === 0 && unit[1] === 0) {
      if (unit[2] === 1) {
        offset = 3
      } else if (unit.length > 3 && unit[2] === 0 && unit[3] === 1) {
        offset = 4
      }
    }
    if (offset >= unit.length) {
      return unit
    }
    return unit.subarray(offset)
  }

  function buildAvcConfig(sps, pps) {
    var totalLength = 11 + sps.length + pps.length
    var avcc = new Uint8Array(totalLength)
    avcc[0] = 1
    avcc[1] = sps[1] || 0
    avcc[2] = sps[2] || 0
    avcc[3] = sps[3] || 0
    avcc[4] = 0xFC | 3 // lengthSizeMinusOne = 3 (4 bytes)
    avcc[5] = 0xE0 | 1 // one SPS
    avcc[6] = (sps.length >>> 8) & 0xFF
    avcc[7] = sps.length & 0xFF
    avcc.set(sps, 8)
    var offset = 8 + sps.length
    avcc[offset] = 1 // PPS count
    avcc[offset + 1] = (pps.length >>> 8) & 0xFF
    avcc[offset + 2] = pps.length & 0xFF
    avcc.set(pps, offset + 3)
    return avcc
  }

  function buildCodecString(sps) {
    if (!sps || sps.length < 4) {
      return 'avc1.42001E'
    }

    var profile = sps[1].toString(16).toUpperCase().padStart(2, '0')
    var constraints = sps[2].toString(16).toUpperCase().padStart(2, '0')
    var level = sps[3].toString(16).toUpperCase().padStart(2, '0')
    return 'avc1.' + profile + constraints + level
  }

  function removeEmulationPrevention(bytes) {
    var out = []
    for (var i = 0; i < bytes.length; ++i) {
      if (i > 1 && bytes[i] === 0x03 && bytes[i - 1] === 0x00 && bytes[i - 2] === 0x00) {
        continue
      }
      out.push(bytes[i])
    }
    return new Uint8Array(out)
  }

  function BitReader(bytes) {
    this.bytes = bytes
    this.index = 0
    this.bitOffset = 0
  }

  BitReader.prototype.readBits = function(count) {
    var value = 0
    while (count > 0) {
      if (this.index >= this.bytes.length) {
        return value
      }
      var remaining = 8 - this.bitOffset
      var take = Math.min(remaining, count)
      var shift = remaining - take
      var mask = (0xFF >> (8 - take)) << shift
      value = (value << take) | ((this.bytes[this.index] & mask) >> shift)
      this.bitOffset += take
      if (this.bitOffset === 8) {
        this.bitOffset = 0
        this.index += 1
      }
      count -= take
    }
    return value
  }

  BitReader.prototype.readUEG = function() {
    var zeros = 0
    while (this.readBits(1) === 0 && this.index < this.bytes.length) {
      zeros += 1
    }
    var value = (1 << zeros) - 1 + this.readBits(zeros)
    return value
  }

  BitReader.prototype.readSEG = function() {
    var value = this.readUEG()
    var sign = (value & 1) ? 1 : -1
    return sign * Math.ceil(value / 2)
  }

  function parseSpsDimensions(sps) {
    try {
      var rbsp = removeEmulationPrevention(sps.subarray(1))
      var br = new BitReader(rbsp)
      var profileIdc = br.readBits(8)
      br.readBits(8)
      br.readBits(8)
      br.readUEG() // seq_parameter_set_id

      var chromaFormatIdc = 1
      if (profileIdc === 100 || profileIdc === 110 || profileIdc === 122 || profileIdc === 244 ||
        profileIdc === 44 || profileIdc === 83 || profileIdc === 86 || profileIdc === 118 ||
        profileIdc === 128 || profileIdc === 138 || profileIdc === 139 || profileIdc === 134) {
        chromaFormatIdc = br.readUEG()
        if (chromaFormatIdc === 3) {
          br.readBits(1) // separate_colour_plane_flag
        }
        br.readUEG() // bit_depth_luma_minus8
        br.readUEG() // bit_depth_chroma_minus8
        br.readBits(1) // qpprime_y_zero_transform_bypass_flag
        var scalingMatrix = br.readBits(1)
        if (scalingMatrix) {
          var scalingListCount = chromaFormatIdc !== 3 ? 8 : 12
          for (var i = 0; i < scalingListCount; ++i) {
            var size = i < 6 ? 16 : 64
            var lastScale = 8
            var nextScale = 8
            for (var j = 0; j < size; ++j) {
              if (nextScale !== 0) {
                var delta = br.readSEG()
                nextScale = (lastScale + delta + 256) % 256
              }
              lastScale = nextScale === 0 ? lastScale : nextScale
            }
          }
        }
      }

      br.readUEG() // log2_max_frame_num_minus4
      var picOrderCntType = br.readUEG()
      if (picOrderCntType === 0) {
        br.readUEG()
      } else if (picOrderCntType === 1) {
        br.readBits(1)
        br.readSEG()
        br.readSEG()
        var cycleCount = br.readUEG()
        for (var c = 0; c < cycleCount; ++c) {
          br.readSEG()
        }
      }

      br.readUEG() // max_num_ref_frames
      br.readBits(1) // gaps_in_frame_num_value_allowed_flag
      var picWidthInMbsMinus1 = br.readUEG()
      var picHeightInMapUnitsMinus1 = br.readUEG()
      var frameMbsOnlyFlag = br.readBits(1)
      if (!frameMbsOnlyFlag) {
        br.readBits(1)
      }
      br.readBits(1) // direct_8x8_inference_flag
      var frameCropping = br.readBits(1)

      var frameCropLeft = 0
      var frameCropRight = 0
      var frameCropTop = 0
      var frameCropBottom = 0
      if (frameCropping) {
        frameCropLeft = br.readUEG()
        frameCropRight = br.readUEG()
        frameCropTop = br.readUEG()
        frameCropBottom = br.readUEG()
      }

      var width = (picWidthInMbsMinus1 + 1) * 16
      var height = (picHeightInMapUnitsMinus1 + 1) * 16
      if (!frameMbsOnlyFlag) {
        height *= 2
      }

      var chromaFormat = chromaFormatIdc === 0 ? 1 : 2
      var subWidthC = chromaFormatIdc === 3 ? 1 : 2
      var subHeightC = chromaFormatIdc === 1 ? 2 : 1
      if (chromaFormatIdc === 0) {
        subWidthC = 1
        subHeightC = 2
      }

      var cropUnitX = chromaFormat === 3 ? 1 : subWidthC
      var cropUnitY = (chromaFormatIdc === 0 ? 2 : subHeightC) * (frameMbsOnlyFlag ? 1 : 2)

      width -= (frameCropLeft + frameCropRight) * cropUnitX
      height -= (frameCropTop + frameCropBottom) * cropUnitY

      return {
        width: width,
        height: height
      }
    }
    catch (err) {
      console.warn('[H264Renderer] Failed to parse SPS dimensions:', err)
      return {
        width: 0,
        height: 0
      }
    }
  }

  function concatUint8Arrays(arrays) {
    var total = arrays.reduce(function(sum, arr) {
      return sum + arr.length
    }, 0)
    var result = new Uint8Array(total)
    var offset = 0
    arrays.forEach(function(arr) {
      result.set(arr, offset)
      offset += arr.length
    })
    return result
  }

  function uint32ToBytes(value) {
    return new Uint8Array([
      (value >>> 24) & 0xFF,
      (value >>> 16) & 0xFF,
      (value >>> 8) & 0xFF,
      value & 0xFF
    ])
  }

  function uint16ToBytes(value) {
    return new Uint8Array([
      (value >>> 8) & 0xFF,
      value & 0xFF
    ])
  }

  function uint8ToBytes(value) {
    return new Uint8Array([value & 0xFF])
  }

  function stringToBytes(str) {
    var bytes = new Uint8Array(str.length)
    for (var i = 0; i < str.length; ++i) {
      bytes[i] = str.charCodeAt(i)
    }
    return bytes
  }

  function box(type) {
    var payloads = Array.prototype.slice.call(arguments, 1)
    var size = 8
    payloads.forEach(function(payload) {
      size += payload.length
    })
    var result = new Uint8Array(size)
    var view = new DataView(result.buffer)
    view.setUint32(0, size)
    result.set(stringToBytes(type), 4)
    var offset = 8
    payloads.forEach(function(payload) {
      result.set(payload, offset)
      offset += payload.length
    })
    return result
  }

  function fullBox(type, version, flags) {
    var payloads = Array.prototype.slice.call(arguments, 3)
    var header = new Uint8Array(4)
    header[0] = version & 0xFF
    header[1] = (flags >>> 16) & 0xFF
    header[2] = (flags >>> 8) & 0xFF
    header[3] = flags & 0xFF
    return box.apply(null, [type, header].concat(payloads))
  }

  function createMatrix() {
    return new Uint8Array([
      0x00, 0x01, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00
    ])
  }

  function createFtypBox() {
    return box('ftyp',
      stringToBytes('isom'),
      uint32ToBytes(0x200),
      stringToBytes('isom'),
      stringToBytes('iso6'),
      stringToBytes('avc1'),
      stringToBytes('mp41')
    )
  }

  function createMvhdBox(timescale) {
    return fullBox('mvhd', 0, 0,
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(timescale),
      uint32ToBytes(0),
      uint32ToBytes(0x00010000),
      uint16ToBytes(0x0100),
      uint16ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      createMatrix(),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(1)
    )
  }

  function createTkhdBox(track) {
    return fullBox('tkhd', 0, 7,
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(track.id),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint16ToBytes(0),
      uint16ToBytes(0),
      uint16ToBytes(0),
      uint16ToBytes(0),
      createMatrix(),
      uint32ToBytes(track.width << 16),
      uint32ToBytes(track.height << 16)
    )
  }

  function createMdhdBox(timescale) {
    return fullBox('mdhd', 0, 0,
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(timescale),
      uint32ToBytes(0),
      uint16ToBytes(0x55c4),
      uint16ToBytes(0)
    )
  }

  function createHdlrBox(handlerType) {
    return fullBox('hdlr', 0, 0,
      uint32ToBytes(0),
      stringToBytes(handlerType),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint8ToBytes(0)
    )
  }

  function createVmhdBox() {
    return fullBox('vmhd', 0, 0x000001,
      uint16ToBytes(0),
      uint16ToBytes(0),
      uint16ToBytes(0),
      uint16ToBytes(0)
    )
  }

  function createDrefBox() {
    var url = fullBox('url ', 0, 0x000001)
    return fullBox('dref', 0, 0, uint32ToBytes(1), url)
  }

  function createDinfBox() {
    return box('dinf', createDrefBox())
  }

  function createStsdBox(track) {
    var avcC = box('avcC', track.avcc)
    var avc1 = box('avc1',
      new Uint8Array(6),
      uint16ToBytes(1),
      uint16ToBytes(0),
      uint16ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint32ToBytes(0),
      uint16ToBytes(track.width),
      uint16ToBytes(track.height),
      uint32ToBytes(0x00480000),
      uint32ToBytes(0x00480000),
      uint32ToBytes(0),
      uint16ToBytes(1),
      new Uint8Array(32),
      uint16ToBytes(24),
      uint16ToBytes(0xFFFF),
      avcC
    )
    return fullBox('stsd', 0, 0, uint32ToBytes(1), avc1)
  }

  function createSttsBox() {
    return fullBox('stts', 0, 0, uint32ToBytes(0))
  }

  function createStscBox() {
    return fullBox('stsc', 0, 0, uint32ToBytes(0))
  }

  function createStszBox() {
    return fullBox('stsz', 0, 0,
      uint32ToBytes(0),
      uint32ToBytes(0))
  }

  function createStcoBox() {
    return fullBox('stco', 0, 0, uint32ToBytes(0))
  }

  function createStblBox(track) {
    return box('stbl',
      createStsdBox(track),
      createSttsBox(),
      createStscBox(),
      createStszBox(),
      createStcoBox()
    )
  }

  function createMinfBox(track) {
    return box('minf',
      createVmhdBox(),
      createDinfBox(),
      createStblBox(track)
    )
  }

  function createMdiaBox(track) {
    return box('mdia',
      createMdhdBox(track.timescale),
      createHdlrBox('vide'),
      createMinfBox(track)
    )
  }

  function createTrakBox(track) {
    return box('trak',
      createTkhdBox(track),
      createMdiaBox(track)
    )
  }

  function createMoovBox(track) {
    return box('moov',
      createMvhdBox(track.timescale),
      createTrakBox(track)
    )
  }

  function createInitSegment(track) {
    return concatUint8Arrays([
      createFtypBox(),
      createMoovBox(track)
    ])
  }

  function writeSampleFlags(sample) {
    if (sample.isKeyframe) {
      return uint32ToBytes(0x02000000)
    }
    return uint32ToBytes(0x01010000)
  }

  function createMoofBox(track, baseMediaDecodeTime, sequenceNumber, sample) {
    var mfhd = fullBox('mfhd', 0, 0, uint32ToBytes(sequenceNumber))
    var tfhd = fullBox('tfhd', 0, 0x020000, uint32ToBytes(track.id))
    var tfdt = fullBox('tfdt', 0, 0, uint32ToBytes(baseMediaDecodeTime))

    var sampleCount = 1
    var trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400
    var trunHeader = concatUint8Arrays([
      uint32ToBytes(sampleCount),
      uint32ToBytes(0) // placeholder for data offset
    ])
    var trunSample = concatUint8Arrays([
      uint32ToBytes(sample.duration),
      uint32ToBytes(sample.data.length),
      writeSampleFlags(sample)
    ])
    var trun = fullBox('trun', 0, trunFlags, trunHeader, trunSample)

    var traf = box('traf', tfhd, tfdt, trun)
    var moof = box('moof', mfhd, traf)

    var dataOffsetPosition = 8 // moof header
    dataOffsetPosition += mfhd.length
    dataOffsetPosition += 8 // traf header
    dataOffsetPosition += tfhd.length
    dataOffsetPosition += tfdt.length
    // trun box
    dataOffsetPosition += 8 // trun size+type
    dataOffsetPosition += 4 // version/flags
    dataOffsetPosition += 4 // sample_count

    var view = new DataView(moof.buffer)
    view.setUint32(dataOffsetPosition, moof.length + 8)

    return moof
  }

  function createMdatBox(sample) {
    return box('mdat', sample.data)
  }

  function createFragment(track, baseMediaDecodeTime, sequenceNumber, sample) {
    var moof = createMoofBox(track, baseMediaDecodeTime, sequenceNumber, sample)
    var mdat = createMdatBox(sample)
    return concatUint8Arrays([moof, mdat])
  }

  function H264Renderer(canvas) {
    this.canvas = canvas
    this.player = null
    this.source = null
    this.isActive = false

    this.canvasCtx = null
    this.backend = hasWebCodecSupport($window) ? 'webcodecs'
      : (hasMediaSourceSupport($window) ? 'mse' : 'jsmpeg')
    this.decoder = null
    this.decoderConfigured = false
    this.pendingSps = null
    this.pendingPps = null
    this.timestampOrigin = null
    this.lastTimestamp = 0
    this.codecString = null

    this.mediaSource = null
    this.sourceBuffer = null
    this.mseQueue = []
    this.mseInitAppended = false
    this.mseSequence = 1
    this.mseBaseDts = 0
    this.mseTimescale = 1000000
    this.mseFrameDuration = 33333
    this.videoElement = null
    this.mseAnimationFrame = null
    this.mseReady = false
  }

  H264Renderer.prototype.start = function() {
    if (this.isActive) {
      return
    }

    if (this.backend === 'webcodecs') {
      try {
        this.canvasCtx = this.canvas.getContext('2d')
        this.decoder = new $window.VideoDecoder({
          output: this._handleDecodedFrame.bind(this),
          error: function(err) {
            console.error('[H264Renderer] VideoDecoder error:', err)
          }
        })
        console.log('[H264Renderer] Started with WebCodecs backend')
        this.isActive = true
        return
      } catch (err) {
        console.warn('[H264Renderer] WebCodecs initialization failed, falling back to JSMpeg', err)
        this.backend = hasMediaSourceSupport($window) ? 'mse' : 'jsmpeg'
      }
    }

    if (this.backend === 'mse') {
      try {
        this.canvasCtx = this.canvas.getContext('2d')
        this._initMseBackend()
        this.isActive = true
        console.log('[H264Renderer] Started with MediaSource backend')
        return
      } catch (err) {
        console.warn('[H264Renderer] MediaSource initialization failed, falling back to JSMpeg', err)
        this.backend = 'jsmpeg'
      }
    }

    if (this.backend === 'jsmpeg') {
      if (!$window.JSMpeg) {
        console.error('[H264Renderer] No decoding backend available (WebCodecs/JSMpeg missing)')
        return
      }

      console.log('[H264Renderer] Starting with JSMpeg backend')

      function CustomSource() {
        this.destination = null
      }

      CustomSource.prototype.connect = function(destination) {
        this.destination = destination
      }

      CustomSource.prototype.start = function() {}
      CustomSource.prototype.resume = function() {}
      CustomSource.prototype.destroy = function() {
        this.destination = null
      }

      this.player = new $window.JSMpeg.Player(null, {
        source: CustomSource,
        canvas: this.canvas,
        disableGl: true,
        disableWebAssembly: false,
        progressive: true,
        throttled: false,
        videoBufferSize: 512 * 1024,
        maxAudioLag: 0
      })
      this.source = this.player.source
      this.source.write = function(data) {
        if (this.destination) {
          this.destination.write(data)
        }
      }
      console.log('[H264Renderer] JSMpeg player created')
      this.isActive = true
    }
  }

  H264Renderer.prototype.stop = function() {
    if (!this.isActive) {
      return
    }

    console.log('[H264Renderer] Stopping')

    if (this.mseAnimationFrame !== null) {
      $window.cancelAnimationFrame(this.mseAnimationFrame)
      this.mseAnimationFrame = null
    }

    if (this.videoElement) {
      try {
        this.videoElement.pause()
      } catch (e) { /* noop */ }
      if (this.videoElement.src) {
        $window.URL.revokeObjectURL(this.videoElement.src)
      }
      this.videoElement.src = ''
      this.videoElement = null
    }

    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream()
        }
      } catch (e) { /* noop */ }
      this.mediaSource = null
    }

    this.sourceBuffer = null
    this.mseQueue = []
    this.mseInitAppended = false
    this.mseReady = false

    if (this.decoder) {
      try {
        this.decoder.close()
      } catch (err) {
        console.warn('[H264Renderer] Failed to close VideoDecoder', err)
      }
    }

    this.decoder = null
    this.decoderConfigured = false
    this.pendingSps = null
    this.pendingPps = null
    this.timestampOrigin = null
    this.lastTimestamp = 0
    this.codecString = null
    this.mseSequence = 1
    this.mseBaseDts = 0

    if (this.player) {
      this.player.destroy()
      this.player = null
    }

    if (this.source) {
      this.source.destroy()
      this.source = null
    }

    this.canvasCtx = null
    this.isActive = false
  }

  H264Renderer.prototype._handleDecodedFrame = function(frame) {
    try {
      if (!this.canvasCtx) {
        return
      }

      var width = frame.displayWidth || frame.codedWidth
      var height = frame.displayHeight || frame.codedHeight

      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width
        this.canvas.height = height
      }

      this.canvasCtx.drawImage(frame, 0, 0, width, height)
    } catch (err) {
      console.error('[H264Renderer] Failed to render frame:', err)
    } finally {
      frame.close()
    }
  }

  H264Renderer.prototype._ensureDecoderConfigured = function() {
    if (this.decoderConfigured || !this.pendingSps || !this.pendingPps || !this.decoder) {
      return this.decoderConfigured
    }

    try {
      var codecString = buildCodecString(this.pendingSps)
      var description = buildAvcConfig(this.pendingSps, this.pendingPps)
      this.decoder.configure({
        codec: codecString,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
        description: description.buffer
      })
      this.decoderConfigured = true
      console.log('[H264Renderer] VideoDecoder configured with codec', codecString)
    } catch (err) {
      console.error('[H264Renderer] Failed to configure VideoDecoder:', err)
      this.decoderConfigured = false
    }

    return this.decoderConfigured
  }

  H264Renderer.prototype._nextTimestamp = function() {
    var now = typeof $window.performance !== 'undefined' && $window.performance && $window.performance.now
      ? $window.performance.now()
      : Date.now()

    if (this.timestampOrigin === null) {
      this.timestampOrigin = now
    }

    var timestamp = Math.max(0, Math.round((now - this.timestampOrigin) * 1000))
    if (timestamp <= this.lastTimestamp) {
      timestamp = this.lastTimestamp + 1
    }

    this.lastTimestamp = timestamp
    return timestamp
  }

  H264Renderer.prototype._decodeWithWebCodecs = function(bytes) {
    if (!this.decoder || this.decoder.state === 'closed') {
      return
    }

    var nalUnits = extractNalUnits(bytes)
    if (!nalUnits.length) {
      return
    }

    for (var i = 0; i < nalUnits.length; ++i) {
      var type = getNalType(nalUnits[i])
      if (type === 7) {
        this.pendingSps = stripStartCode(nalUnits[i])
      } else if (type === 8) {
        this.pendingPps = stripStartCode(nalUnits[i])
      }
    }

    if (!this._ensureDecoderConfigured()) {
      return
    }

    var onlyParameterSets = nalUnits.every(function(unit) {
      var type = getNalType(unit)
      return type === 7 || type === 8 || type === 9
    })

    if (onlyParameterSets) {
      return
    }

    try {
      var chunk = new $window.EncodedVideoChunk({
        type: containsIdr(nalUnits) ? 'key' : 'delta',
        timestamp: this._nextTimestamp(),
        data: bytes
      })
      this.decoder.decode(chunk)
    } catch (err) {
      console.error('[H264Renderer] Failed to decode chunk:', err)
    }
  }

  H264Renderer.prototype._writeToJSMpeg = function(bytes) {
    if (!this.source) {
      return
    }
    this.source.write(bytes)
  }

  H264Renderer.prototype._handleBytes = function(bytes) {
    if (!this.isActive) {
      return
    }

    if (this.backend === 'webcodecs') {
      this._decodeWithWebCodecs(bytes)
    } else if (this.backend === 'mse') {
      this._processWithMse(bytes)
    } else {
      this._writeToJSMpeg(bytes)
    }
  }

  H264Renderer.prototype.processData = function(data) {
    if (!this.isActive) {
      return
    }

    try {
      var self = this
      if (data instanceof Blob) {
        if (typeof data.arrayBuffer === 'function') {
          data.arrayBuffer().then(function(buffer) {
            self._handleBytes(new Uint8Array(buffer))
          }).catch(function(err) {
            console.error('[H264Renderer] Failed to read Blob data:', err)
          })
        } else {
          var reader = new FileReader()
          reader.onload = function() {
            self._handleBytes(new Uint8Array(reader.result))
          }
          reader.onerror = function(err) {
            console.error('[H264Renderer] Blob read error:', err)
          }
          reader.readAsArrayBuffer(data)
        }
      } else if (data instanceof ArrayBuffer) {
        this._handleBytes(new Uint8Array(data))
      } else if (data instanceof Uint8Array) {
        this._handleBytes(data)
      } else if (data && data.buffer instanceof ArrayBuffer) {
        this._handleBytes(new Uint8Array(data.buffer))
      }
    } catch (err) {
      console.error('[H264Renderer] Error processing data:', err)
    }
  }

  H264Renderer.prototype._initMseBackend = function() {
    var self = this
    this.videoElement = $window.document.createElement('video')
    this.videoElement.muted = true
    this.videoElement.autoplay = true
    this.videoElement.playsInline = true
    this.videoElement.setAttribute('playsinline', '')

    this.mediaSource = new $window.MediaSource()
    this.videoElement.src = $window.URL.createObjectURL(this.mediaSource)

    this.mediaSource.addEventListener('sourceopen', function() {
      self.mseReady = true
      self._createSourceBufferIfPossible()
      self._flushMseQueue()
    })

    this.videoElement.play().catch(function(err) {
      console.warn('[H264Renderer] Video autoplay failed:', err)
    })

    var draw = function() {
      if (!self.isActive || !self.videoElement) {
        return
      }

      if (self.videoElement.readyState >= 2 && self.canvasCtx) {
        var width = self.videoElement.videoWidth
        var height = self.videoElement.videoHeight
        if (width && height) {
          if (self.canvas.width !== width || self.canvas.height !== height) {
            self.canvas.width = width
            self.canvas.height = height
          }
          self.canvasCtx.drawImage(self.videoElement, 0, 0, width, height)
        }
      }
      self.mseAnimationFrame = $window.requestAnimationFrame(draw)
    }

    this.mseAnimationFrame = $window.requestAnimationFrame(draw)
  }

  H264Renderer.prototype._createSourceBufferIfPossible = function() {
    if (!this.mediaSource || this.sourceBuffer || !this.pendingSps || !this.pendingPps) {
      return !!this.sourceBuffer
    }
    if (this.mediaSource.readyState !== 'open') {
      return false
    }

    this.codecString = buildCodecString(this.pendingSps)
    var mimeType = 'video/mp4; codecs="' + this.codecString + '"'

    if (!$window.MediaSource.isTypeSupported(mimeType)) {
      console.error('[H264Renderer] MediaSource does not support codec:', mimeType)
      return false
    }

    try {
      var self = this
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType)
      this.sourceBuffer.mode = 'sequence'
      this.sourceBuffer.addEventListener('updateend', function() {
        self._flushMseQueue()
      })
      console.log('[H264Renderer] MSE SourceBuffer created with MIME', mimeType)
      return true
    } catch (err) {
      console.error('[H264Renderer] Failed to create SourceBuffer:', err)
      return false
    }
  }

  H264Renderer.prototype._enqueueMseSegment = function(segment) {
    if (!segment || !segment.length) {
      return
    }
    this.mseQueue.push(segment)
    this._flushMseQueue()
  }

  H264Renderer.prototype._flushMseQueue = function() {
    if (!this.sourceBuffer || !this.mseQueue.length || this.sourceBuffer.updating) {
      return
    }
    try {
      var segment = this.mseQueue.shift()
      this.sourceBuffer.appendBuffer(segment)
    } catch (err) {
      console.error('[H264Renderer] Failed to append MSE segment:', err)
      this.mseQueue = []
    }
  }

  H264Renderer.prototype._buildSampleData = function(units) {
    var processed = units.map(function(unit) {
      return stripStartCode(unit)
    }).filter(function(unit) {
      return unit && unit.length
    })

    var total = processed.reduce(function(sum, unit) {
      return sum + 4 + unit.length
    }, 0)
    var result = new Uint8Array(total)
    var offset = 0
    processed.forEach(function(unit) {
      var length = unit.length
      result[offset] = (length >>> 24) & 0xFF
      result[offset + 1] = (length >>> 16) & 0xFF
      result[offset + 2] = (length >>> 8) & 0xFF
      result[offset + 3] = length & 0xFF
      offset += 4
      result.set(unit, offset)
      offset += length
    })
    return result
  }

  H264Renderer.prototype._processWithMse = function(bytes) {
    if (!bytes || !bytes.length) {
      return
    }

    var nalUnits = extractNalUnits(bytes)
    if (!nalUnits.length) {
      return
    }

    var sampleUnits = []
    var self = this

    nalUnits.forEach(function(unit) {
      var type = getNalType(unit)
      if (type === 7) {
        self.pendingSps = stripStartCode(unit)
        self.codecString = buildCodecString(unit)
        self._createSourceBufferIfPossible()
      } else if (type === 8) {
        self.pendingPps = stripStartCode(unit)
        self._createSourceBufferIfPossible()
      } else if (type === 6) {
        // ignore SEI
      } else if (type > 0) {
        sampleUnits.push(unit)
      }
    })

    if (!sampleUnits.length) {
      return
    }

    if (!this.pendingSps || !this.pendingPps) {
      console.warn('[H264Renderer] Waiting for SPS/PPS before decoding')
      return
    }

    if (!this.sourceBuffer && !this._createSourceBufferIfPossible()) {
      return
    }

    if (!this.mseInitAppended) {
      var dims = parseSpsDimensions(this.pendingSps)
      var track = {
        id: 1,
        timescale: this.mseTimescale,
        width: dims.width || this.canvas.width || 0,
        height: dims.height || this.canvas.height || 0,
        avcc: buildAvcConfig(this.pendingSps, this.pendingPps)
      }
      var initSegment = createInitSegment(track)
      this._enqueueMseSegment(initSegment)
      this.mseInitAppended = true
      this.mseTrack = track
    }

    if (!this.mseTrack) {
      return
    }

    var sampleData = this._buildSampleData(sampleUnits)
    var sample = {
      data: sampleData,
      duration: this.mseFrameDuration,
      isKeyframe: containsIdr(sampleUnits)
    }

    var fragment = createFragment(this.mseTrack, this.mseBaseDts, this.mseSequence, sample)
    this.mseSequence += 1
    this.mseBaseDts += this.mseFrameDuration
    this._enqueueMseSegment(fragment)
  }

  return {
    create: function(canvas) {
      return new H264Renderer(canvas)
    }
  }
}
