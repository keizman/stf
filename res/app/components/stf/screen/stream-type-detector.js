/**
 * Stream Type Detector
 * Detects JPEG vs H.264 video streams
 */

module.exports = {
  detectType: function(data) {
    // For Blob, try to peek at bytes
    if (data instanceof Blob) {
      // Default to JPEG for backward compatibility
      // Real detection would need async, so we use magic bytes check later
      return 'unknown'
    }

    var bytes = this.getFirstBytes(data, 4)
    if (!bytes || bytes.length < 2) {
      return 'jpeg'
    }

    // JPEG magic bytes: 0xFF 0xD8
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      return 'jpeg'
    }

    // H.264 NAL unit start codes
    // 0x00 0x00 0x00 0x01 or 0x00 0x00 0x01
    if (bytes.length >= 4 && 
        bytes[0] === 0x00 && bytes[1] === 0x00 && 
        bytes[2] === 0x00 && bytes[3] === 0x01) {
      return 'h264'
    }

    if (bytes.length >= 3 &&
        bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01) {
      return 'h264'
    }

    // scrcpy dummy byte
    if (bytes[0] === 0x00) {
      return 'h264'
    }

    return 'jpeg'
  },

  getFirstBytes: function(data, n) {
    try {
      if (data instanceof Uint8Array) {
        return data.slice(0, n)
      } else if (data instanceof ArrayBuffer) {
        return new Uint8Array(data).slice(0, n)
      }
    } catch (err) {
      console.error('[StreamTypeDetector] Error:', err)
    }
    return null
  },

  detectTypeAsync: function(blob) {
    var self = this
    return new Promise(function(resolve) {
      if (!(blob instanceof Blob)) {
        resolve(self.detectType(blob))
        return
      }

      var reader = new FileReader()
      reader.onload = function() {
        var type = self.detectType(reader.result)
        resolve(type)
      }
      reader.onerror = function() {
        resolve('jpeg')
      }
      
      var slice = blob.slice(0, 10)
      reader.readAsArrayBuffer(slice)
    })
  }
}
