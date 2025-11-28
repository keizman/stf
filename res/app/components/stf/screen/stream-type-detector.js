/**
 * Stream type detector
 * Detects whether the incoming stream is JPEG or H.264
 */

var StreamTypeDetector = {
  /**
   * Detect stream type from data
   * @param {Blob|ArrayBuffer|Uint8Array} data - The data to analyze
   * @returns {string} 'jpeg' or 'h264'
   */
  detectType: function(data) {
    if (data instanceof Blob) {
      // For Blob, we need to read it asynchronously
      // Return 'unknown' and use detectTypeAsync instead
      return 'unknown'
    }

    var bytes
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (data instanceof Uint8Array) {
      bytes = data
    } else {
      return 'unknown'
    }

    return this._detectFromBytes(bytes)
  },

  /**
   * Async version that handles Blobs
   * @param {Blob|ArrayBuffer|Uint8Array} data - The data to analyze
   * @returns {Promise<string>} Promise resolving to 'jpeg' or 'h264'
   */
  detectTypeAsync: function(data) {
    var self = this

    if (data instanceof Blob) {
      return new Promise(function(resolve) {
        var reader = new FileReader()
        reader.onload = function() {
          var bytes = new Uint8Array(reader.result)
          resolve(self._detectFromBytes(bytes))
        }
        reader.onerror = function() {
          resolve('unknown')
        }
        // Read first 16 bytes
        reader.readAsArrayBuffer(data.slice(0, 16))
      })
    }

    return Promise.resolve(this.detectType(data))
  },

  /**
   * Detect type from byte array
   * @param {Uint8Array} bytes - The bytes to analyze
   * @returns {string} 'jpeg' or 'h264'
   */
  _detectFromBytes: function(bytes) {
    if (bytes.length < 4) {
      return 'unknown'
    }

    // JPEG magic bytes: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return 'jpeg'
    }

    // H.264 NAL start codes:
    // 4-byte: 00 00 00 01
    // 3-byte: 00 00 01
    if ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x01) ||
        (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01)) {
      return 'h264'
    }

    // Check for H.264 NAL unit type patterns (without start code)
    // This might happen if the start code was stripped
    var firstByte = bytes[0]
    var nalType = firstByte & 0x1F
    var nalRefIdc = (firstByte >> 5) & 0x03
    var forbiddenBit = (firstByte >> 7) & 0x01

    // Valid H.264 NAL unit: forbidden_zero_bit = 0, nal_unit_type = 1-23
    if (forbiddenBit === 0 && nalType >= 1 && nalType <= 23) {
      return 'h264'
    }

    return 'unknown'
  }
}

module.exports = StreamTypeDetector
