/**
 * Scrcpy screen streaming resource for STF
 * Based on scrcpy server implementation
 * Provides H.264 video stream from Android device
 */

var path = require('path')
var net = require('net')
var Promise = require('bluebird')
var EventEmitter = require('eventemitter3')

var logger = require('../../../util/logger')
var syrup = require('@devicefarmer/stf-syrup')

function isStartCode(buffer, index) {
  if (index + 3 >= buffer.length) {
    return 0
  }
  if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 1) {
    return 3
  }
  if (index + 4 < buffer.length &&
    buffer[index] === 0 && buffer[index + 1] === 0 &&
    buffer[index + 2] === 0 && buffer[index + 3] === 1) {
    return 4
  }
  return 0
}

function splitAnnexBNalus(buffer) {
  var units = []
  var lastIndex = -1
  for (var i = 0; i < buffer.length - 3; ++i) {
    var startSize = isStartCode(buffer, i)
    if (startSize) {
      if (lastIndex >= 0) {
        units.push(buffer.slice(lastIndex, i))
      }
      lastIndex = i
      i += startSize - 1
    }
  }

  if (lastIndex >= 0 && lastIndex < buffer.length) {
    units.push(buffer.slice(lastIndex))
  }

  return units
}

function getNalType(unit) {
  if (!unit || unit.length < 4) {
    return -1
  }
  var startSize = isStartCode(unit, 0)
  if (!startSize || startSize >= unit.length) {
    return -1
  }
  return unit[startSize] & 0x1F
}

function containsIdr(units) {
  return units.some(function(unit) {
    return getNalType(unit) === 5
  })
}

function isConfigOnly(units) {
  if (!units.length) {
    return false
  }
  return units.every(function(unit) {
    var type = getNalType(unit)
    return type === 6 || type === 7 || type === 8 || type === 9
  })
}

module.exports = syrup.serial()
  .dependency(require('../support/adb'))
  .define(function(options, adb) {
    var log = logger.createLogger('device:resources:scrcpy')

    /**
     * Scrcpy client class
     * Manages scrcpy server connection and video stream
     */
    function ScrcpyClient(config) {
      EventEmitter.call(this)
      
      this.config = Object.assign({
        serial: options.serial,
        port: 8099,
        maxSize: 600,
        bitrate: 999999999,  // Use high bitrate like devicehub
        tunnelForward: true,  // Boolean, will be converted to string
        tunnelDelay: 3000,
        crop: '9999:9999:0:0',  // Use devicehub format
        sendFrameMeta: false,
        sendDeviceMeta: true,
        sendCodecMeta: true,
        sendDummyByte: true
      }, config)
      
      this.adb = adb
      this.socket = null
      this.connected = false
      this.stopping = false
      this.configBuffer = Buffer.alloc(0)
      this._initializeHandshakeState()
    }

    ScrcpyClient.prototype = Object.create(EventEmitter.prototype)

    ScrcpyClient.prototype._initializeHandshakeState = function() {
      this.buffer = Buffer.alloc(0)
      this.configBuffer = Buffer.alloc(0)
      this.handshakeQueue = []

      if (this.config.sendDummyByte) {
        this.handshakeQueue.push({
          type: 'dummy',
          size: 1
        })
      }

      if (this.config.sendDeviceMeta) {
        this.handshakeQueue.push({
          type: 'device',
          size: 64
        })
      }

      if (this.config.sendCodecMeta) {
        this.handshakeQueue.push({
          type: 'codec',
          size: 12
        })
      }

      this.handshakeInfo = {
        name: this.config.serial,
        width: 0,
        height: 0,
        codecId: null
      }

      this.handshakeComplete = this.handshakeQueue.length === 0
    }

    /**
     * Start scrcpy server and establish connection
     */
    ScrcpyClient.prototype.start = function() {
      var self = this
      
      log.info('Starting scrcpy for device %s', this.config.serial)
      
      return Promise.resolve()
        .then(function() {
          self._initializeHandshakeState()
          return self._pushServer()
        })
        .then(function() {
          return self._startServer()
        })
        .then(function() {
          return self._createForward()
        })
        .then(function() {
          return self._connect()
        })
        .then(function(deviceInfo) {
          self.connected = true
          log.info('Scrcpy started successfully for %s: %s (%dx%d)', 
            self.config.serial, deviceInfo.name, deviceInfo.width, deviceInfo.height)
          return deviceInfo
        })
        .catch(function(err) {
          log.error('Failed to start scrcpy for %s: %s', self.config.serial, err.message)
          self.stop()
          throw err
        })
    }

    /**
     * Push scrcpy-server.jar to device
     */
    ScrcpyClient.prototype._pushServer = function() {
      var self = this
      var serverPath = path.join(__dirname, 'scrcpy-server.jar')
      var remotePath = '/data/local/tmp/scrcpy-server.jar'
      
      log.info('Pushing scrcpy-server.jar to device %s', this.config.serial)
      
      return adb.push(self.config.serial, serverPath, remotePath)
        .then(function(transfer) {
          return new Promise(function(resolve, reject) {
            transfer.on('progress', function(stats) {
              // Silent progress
            })
            transfer.on('end', function() {
              log.info('Scrcpy server pushed successfully')
              resolve()
            })
            transfer.on('error', reject)
          })
        })
    }

    /**
     * Start scrcpy server on device
     * Uses scrcpy v3.3.3 parameter format: VERSION key=value key=value...
     */
    ScrcpyClient.prototype._startServer = function() {
      var self = this
      
      var remotePath = '/data/local/tmp/scrcpy-server.jar'
      
      // Build command with v3.3.3 parameter format
      // Format: VERSION key=value key=value...
      var cmd = [
        'CLASSPATH=' + remotePath,
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        '3.3.3',                                    // Version (required first parameter)
        'tunnel_forward=true',                      // Wait for client connection
        'max_size=' + this.config.maxSize,         // Max screen size
        'video_bit_rate=' + this.config.bitrate,   // Video bitrate
        'audio=false',                              // Disable audio (STF doesn't need it)
        'control=false',                            // Disable control (STF handles it separately)
        'send_device_meta=' + (this.config.sendDeviceMeta ? 'true' : 'false'),
        'send_frame_meta=false',                    // Don't send PTS for each frame
        'send_codec_meta=' + (this.config.sendCodecMeta ? 'true' : 'false'),
        'send_dummy_byte=' + (this.config.sendDummyByte ? 'true' : 'false'),
        'log_level=info'                            // Logging level
      ].join(' ')
      
      log.info('Starting scrcpy server on device %s with command:', this.config.serial)
      log.info('  Command: %s', cmd)
      log.info('  Max size: %s', this.config.maxSize)
      log.info('  Bitrate: %s', this.config.bitrate)
      log.info('  Remote path: %s', remotePath)
      
      // Execute shell command and capture output
      return adb.shell(self.config.serial, cmd)
        .then(function(output) {
          log.info('Scrcpy server shell output: %s', output ? output.toString().trim() : '(empty)')
        })
        .catch(function(err) {
          log.warn('Scrcpy server shell error (may be normal): %s', err.message)
          // Don't throw - server might be running
        })
    }

    /**
     * Create port forward for scrcpy
     */
    ScrcpyClient.prototype._createForward = function() {
      var self = this
      
      log.info('Creating port forward for scrcpy: tcp:%d -> localabstract:scrcpy', 
        this.config.port)
      
      return adb.client.getDevice(self.config.serial)
        .forward('tcp:' + self.config.port, 'localabstract:scrcpy')
        .then(function() {
          log.info('Port forward created successfully')
        })
    }

    ScrcpyClient.prototype._updateConfigBuffer = function(units) {
      if (!units || !units.length) {
        return
      }
      var total = Buffer.concat(units)
      if (total.length) {
        this.configBuffer = total
        log.info('[SCRCPY] Updated config buffer (%d bytes)', total.length)
      }
    }

    ScrcpyClient.prototype._processVideoPayload = function(payload) {
      var units = splitAnnexBNalus(payload)
      if (!units.length) {
        return payload
      }

      if (isConfigOnly(units)) {
        this._updateConfigBuffer(units)
        return null
      }

      var configUnits = units.filter(function(unit) {
        var type = getNalType(unit)
        return type === 7 || type === 8
      })

      if (configUnits.length) {
        this._updateConfigBuffer(configUnits)
        units = units.filter(function(unit) {
          var type = getNalType(unit)
          return !(type === 7 || type === 8)
        })
      }

      if (!units.length) {
        return null
      }

      var payloadBuffer = Buffer.concat(units)
      if (this.configBuffer.length && containsIdr(units)) {
        payloadBuffer = Buffer.concat([this.configBuffer, payloadBuffer])
      }

      return payloadBuffer
    }

    /**
     * Connect to scrcpy server and setup data stream
     */
    ScrcpyClient.prototype._connect = function() {
      var self = this
      
      // Wait for server to be ready
      return Promise.delay(this.config.tunnelDelay)
        .then(function() {
          return new Promise(function(resolve, reject) {
            log.info('Connecting to scrcpy server at 127.0.0.1:%d', self.config.port)
            
            self.socket = new net.Socket()
            self.socket.setKeepAlive(true)
            self.socket.setNoDelay(true)
            
            var timeout = setTimeout(function() {
              reject(new Error('Connection timeout'))
            }, 10000)
            
            var deviceInfoResolved = false
            var dataCount = 0
            var handshakeCompleteLogged = false
            
            // CRITICAL: Setup data handler BEFORE connecting
            // This ensures we capture all data including the first 69 bytes
            self.socket.on('data', function(data) {
              dataCount++
              log.info('[DATA #%d] Received %d bytes, handshakeComplete=%s, buffer.length=%d', 
                dataCount, data.length, self.handshakeComplete, self.buffer.length)

              self.buffer = Buffer.concat([self.buffer, data])

              function processHandshake() {
                while (!self.handshakeComplete && self.handshakeQueue.length) {
                  var next = self.handshakeQueue[0]
                  if (self.buffer.length < next.size) {
                    return
                  }

                  var chunk = self.buffer.slice(0, next.size)
                  self.buffer = self.buffer.slice(next.size)

                  switch (next.type) {
                  case 'dummy':
                    log.info('[HANDSHAKE] Received dummy byte')
                    break
                  case 'device':
                    self.handshakeInfo.name = chunk.toString('utf8').replace(/\0/g, '') || self.config.serial
                    log.info('[HANDSHAKE] Device name: %s', self.handshakeInfo.name)
                    break
                  case 'codec':
                    self.handshakeInfo.codecId = chunk.readInt32BE(0)
                    self.handshakeInfo.width = chunk.readInt32BE(4)
                    self.handshakeInfo.height = chunk.readInt32BE(8)
                    log.info('[HANDSHAKE] Codec meta received - codecId=%d width=%d height=%d', 
                      self.handshakeInfo.codecId, self.handshakeInfo.width, self.handshakeInfo.height)
                    break
                  }

                  self.handshakeQueue.shift()
                }

                if (!self.handshakeQueue.length) {
                  self.handshakeComplete = true
                  if (!handshakeCompleteLogged) {
                    log.info('[DEVICE INFO] Name: %s, Size: %dx%d',
                      self.handshakeInfo.name,
                      self.handshakeInfo.width,
                      self.handshakeInfo.height)
                    handshakeCompleteLogged = true
                  }

                  if (!deviceInfoResolved) {
                    deviceInfoResolved = true
                    clearTimeout(timeout)
                    resolve({
                      name: self.handshakeInfo.name,
                      width: self.handshakeInfo.width,
                      height: self.handshakeInfo.height
                    })
                  }
                }
              }

              processHandshake()

              if (self.handshakeComplete && self.buffer.length) {
                var videoPayload = self.buffer
                self.buffer = Buffer.alloc(0)
                var processedPayload = self._processVideoPayload(videoPayload)
                if (processedPayload && processedPayload.length) {
                  if (dataCount < 10) {
                    log.info('[VIDEO DATA][SAMPLE] %s', processedPayload.slice(0, 32).toString('hex'))
                  }
                  log.info('[VIDEO DATA] Emitting video data: %d bytes, connected=%s, stopping=%s', 
                    processedPayload.length, self.connected, self.stopping)
                  if (self.connected && !self.stopping) {
                    self.emit('video-data', processedPayload)
                  } else {
                    log.warn('[VIDEO DATA] Skipped - connected=%s, stopping=%s', self.connected, self.stopping)
                  }
                } else {
                  log.info('[VIDEO DATA] Buffer contained config-only data, awaiting next frame')
                }
              }
            })
            
            self.socket.on('end', function() {
              log.warn('Scrcpy socket END event triggered')
              self.emit('end')
            })
            
            self.socket.on('close', function(hadError) {
              log.warn('Scrcpy socket CLOSE event triggered, hadError=%s', hadError)
              self.emit('end')
            })
            
            self.socket.on('error', function(err) {
              log.error('Scrcpy socket ERROR event: %s', err.message)
              clearTimeout(timeout)
              if (!deviceInfoResolved) {
                reject(err)
              } else {
                self.emit('error', err)
              }
            })
            
            self.socket.once('connect', function() {
              log.info('Socket CONNECT event - connection established')
            })
            
            // Connect AFTER setting up handlers
            log.info('Calling socket.connect(%d, "127.0.0.1")', self.config.port)
            self.socket.connect(self.config.port, '127.0.0.1')
          })
        })
    }

    /**
     * Stop scrcpy and clean up
     */
    ScrcpyClient.prototype.stop = function() {
      var self = this
      
      if (self.stopping) {
        return Promise.resolve()
      }
      
      self.stopping = true
      self.connected = false
      
      log.info('Stopping scrcpy for device %s', this.config.serial)
      
      return Promise.resolve()
        .then(function() {
          if (self.socket) {
            self.socket.destroy()
            self.socket = null
          }
        })
        .then(function() {
          // Remove port forward
          return adb.client.getDevice(self.config.serial)
            .forward('tcp:' + self.config.port)
            .catch(function(err) {
              // Ignore errors
              log.info('Failed to remove port forward: %s', err.message)
            })
        })
        .then(function() {
          // Kill scrcpy server
          return adb.shell(self.config.serial, 
            'pkill -f com.genymobile.scrcpy.Server')
            .catch(function() {
              // Ignore errors
            })
        })
        .then(function() {
          self._initializeHandshakeState()
          log.info('Scrcpy stopped')
        })
    }

    return {
      ScrcpyClient: ScrcpyClient,
      createClient: function(config) {
        return new ScrcpyClient(config)
      }
    }
  })
