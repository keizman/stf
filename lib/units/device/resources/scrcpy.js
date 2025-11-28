var Promise = require('bluebird')
var EventEmitter = require('eventemitter3')
var path = require('path')
var net = require('net')
var syrup = require('@devicefarmer/stf-syrup')

var logger = require('../../../util/logger')

module.exports = syrup.serial()
  .dependency(require('../support/adb'))
  .dependency(require('../support/properties'))
  .dependency(require('../support/abi'))
  .dependency(require('../support/sdk'))
  .define(function(options, adb, properties, abi, sdk) {
    var log = logger.createLogger('device:resources:scrcpy')

    var jarPath = path.join(__dirname, 'scrcpy-server.jar')
    var remotePath = '/data/local/tmp/scrcpy-server.jar'

    /**
     * Scrcpy client for STF
     * Connects to scrcpy-server running on Android device and receives H.264 video stream
     */
    function ScrcpyClient(config) {
      EventEmitter.call(this)

      this.config = Object.assign({
        maxSize: 0,           // 0 = no limit, use device resolution
        bitRate: 8000000,     // 8 Mbps
        maxFps: 60,
        tunnelForward: true,
        tunnelDelay: 3000,    // Wait 3 seconds for server socket
        connectRetries: 5,    // Retry connection 5 times
        connectRetryDelay: 1000,
        sendFrameMeta: false, // Don't send frame meta for raw H264
        stayAwake: false,
        powerOffOnClose: false
      }, config)

      this.socket = null
      this.process = null
      this.running = false
      this.deviceName = null
      this.width = 0
      this.height = 0
      this.localPort = null
    }

    ScrcpyClient.prototype = Object.create(EventEmitter.prototype)
    ScrcpyClient.prototype.constructor = ScrcpyClient

    /**
     * Push scrcpy-server.jar to device
     */
    ScrcpyClient.prototype._pushServer = function() {
      var self = this
      log.info('Pushing scrcpy-server.jar to device')

      return adb.push(options.serial, jarPath, remotePath, 0o644)
        .timeout(30000)
        .then(function(transfer) {
          return new Promise(function(resolve, reject) {
            transfer.on('error', function(err) {
              log.error('Push error: %s', err.message)
              reject(err)
            })
            transfer.on('end', function() {
              log.info('scrcpy-server.jar pushed successfully')
              resolve()
            })
          })
        })
    }

    /**
     * Start scrcpy server on device
     */
    ScrcpyClient.prototype._startServer = function() {
      var self = this
      var config = this.config

      // Build scrcpy server command for v2.4
      // Format: CLASSPATH=/path/to/server.jar app_process / com.genymobile.scrcpy.Server <version> [options...]
      var cmd = [
        'CLASSPATH=' + remotePath,
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        '2.4',
        'log_level=verbose',
        'video=true',
        'audio=false',
        'control=false',
        'max_size=' + config.maxSize,
        'video_bit_rate=' + config.bitRate,
        'max_fps=' + config.maxFps,
        'tunnel_forward=' + config.tunnelForward,
        'send_frame_meta=' + config.sendFrameMeta,
        'send_dummy_byte=true'
      ].join(' ')

      log.info('Starting scrcpy server: %s', cmd)

      return adb.shell(options.serial, cmd)
        .then(function(stream) {
          self.process = stream
          log.info('Scrcpy shell started, waiting for server...')

          stream.on('data', function(data) {
            var output = data.toString().trim()
            if (output) {
              log.info('scrcpy server output: %s', output)
              // Check if server is ready
              if (output.indexOf('Device:') !== -1) {
                log.info('Scrcpy server reported device info, server should be ready')
              }
            }
          })

          stream.on('error', function(err) {
            log.error('scrcpy server stream error: %s', err.message)
            self.emit('error', err)
          })

          stream.on('end', function() {
            log.warn('scrcpy server process ended unexpectedly')
            self.running = false
            self.emit('end')
          })

          return stream
        })
    }

    /**
     * Setup port forwarding
     */
    ScrcpyClient.prototype._setupForward = function(localPort) {
      var self = this
      log.info('Setting up port forward: tcp:%d -> localabstract:scrcpy', localPort)

      return adb.forward(options.serial, 'tcp:' + localPort, 'localabstract:scrcpy')
        .then(function() {
          log.info('Port forward established successfully')
          self.localPort = localPort
          return localPort
        })
        .catch(function(err) {
          log.error('Failed to setup port forward: %s', err.message)
          throw err
        })
    }

    /**
     * Try to connect to scrcpy socket with retries
     */
    ScrcpyClient.prototype._connectWithRetry = function(port, retriesLeft) {
      var self = this
      
      log.info('Attempting to connect to scrcpy on port %d (retries left: %d)', port, retriesLeft)

      return this._connect(port)
        .catch(function(err) {
          if (retriesLeft > 0) {
            log.warn('Connection failed: %s, retrying in %dms...', err.message, self.config.connectRetryDelay)
            return Promise.delay(self.config.connectRetryDelay)
              .then(function() {
                return self._connectWithRetry(port, retriesLeft - 1)
              })
          }
          throw err
        })
    }

    /**
     * Connect to scrcpy socket and read initial metadata
     */
    ScrcpyClient.prototype._connect = function(port) {
      var self = this
      log.info('Connecting to scrcpy on port %d', port)

      return new Promise(function(resolve, reject) {
        var socket = new net.Socket()
        var connectionTimeout = null
        var resolved = false

        socket.on('connect', function() {
          log.info('TCP connection established to scrcpy server')
          if (connectionTimeout) {
            clearTimeout(connectionTimeout)
          }
        })

        socket.on('error', function(err) {
          log.error('Socket error: %s', err.message)
          if (!resolved) {
            resolved = true
            if (connectionTimeout) clearTimeout(connectionTimeout)
            reject(err)
          }
        })

        socket.on('close', function(hadError) {
          log.info('Socket closed (hadError: %s)', hadError)
          self.running = false
          self.emit('close')
        })

        // Set connection timeout
        connectionTimeout = setTimeout(function() {
          if (!resolved) {
            resolved = true
            socket.destroy()
            reject(new Error('Connection timeout after 10 seconds'))
          }
        }, 10000)

        socket.connect(port, '127.0.0.1', function() {
          if (resolved) return

          self.socket = socket
          log.info('Connected to scrcpy server, waiting for metadata...')

          // For scrcpy v2.x with send_dummy_byte=true:
          // Header format: dummy(1) + device_name(64) + codec(4) + width(4) + height(4) = 77 bytes
          var HEADER_SIZE = 77
          var headerBuffer = Buffer.alloc(0)
          var headerRead = false
          var dataCount = 0

          socket.on('data', function(data) {
            if (!headerRead) {
              headerBuffer = Buffer.concat([headerBuffer, data])
              log.info('Received %d bytes, header buffer now %d bytes (need %d)', 
                data.length, headerBuffer.length, HEADER_SIZE)

              if (headerBuffer.length >= HEADER_SIZE) {
                headerRead = true
                if (connectionTimeout) clearTimeout(connectionTimeout)

                // Parse header (scrcpy v2.x format)
                var dummyByte = headerBuffer[0]
                self.deviceName = headerBuffer.slice(1, 65).toString('utf8').replace(/\0/g, '').trim()
                var codec = headerBuffer.slice(65, 69).toString('ascii')
                self.width = headerBuffer.readUInt32BE(69)
                self.height = headerBuffer.readUInt32BE(73)

                log.info('=== SCRCPY CONNECTED ===')
                log.info('Dummy byte: 0x%s', dummyByte.toString(16))
                log.info('Device: %s', self.deviceName)
                log.info('Codec: %s', codec)
                log.info('Resolution: %dx%d', self.width, self.height)

                // Emit remaining data after header (this is H.264 video data)
                var remaining = headerBuffer.slice(HEADER_SIZE)
                if (remaining.length > 0) {
                  log.info('Emitting %d bytes of video data after header', remaining.length)
                  self.emit('data', remaining)
                }

                if (!resolved) {
                  resolved = true
                  resolve({
                    deviceName: self.deviceName,
                    width: self.width,
                    height: self.height,
                    codec: codec
                  })
                }
              }
            } else {
              // Emit H.264 video data
              dataCount++
              if (dataCount <= 10 || dataCount % 100 === 0) {
                log.info('Received video data chunk #%d: %d bytes', dataCount, data.length)
              }
              self.emit('data', data)
            }
          })
        })
      })
    }

    /**
     * Start scrcpy streaming
     */
    ScrcpyClient.prototype.start = function(localPort) {
      var self = this
      localPort = localPort || 27183 + Math.floor(Math.random() * 1000)

      if (this.running) {
        log.info('Scrcpy already running')
        return Promise.resolve({
          deviceName: this.deviceName,
          width: this.width,
          height: this.height
        })
      }

      log.info('=== STARTING SCRCPY CLIENT ===')
      log.info('Local port: %d', localPort)
      this.running = true

      return this._pushServer()
        .then(function() {
          log.info('Server pushed, starting server process...')
          return self._startServer()
        })
        .then(function() {
          log.info('Server started, setting up port forward...')
          return self._setupForward(localPort)
        })
        .then(function() {
          log.info('Port forward ready, waiting %dms for server socket...', self.config.tunnelDelay)
          return Promise.delay(self.config.tunnelDelay)
        })
        .then(function() {
          log.info('Attempting connection with %d retries...', self.config.connectRetries)
          return self._connectWithRetry(localPort, self.config.connectRetries)
        })
        .then(function(info) {
          log.info('=== SCRCPY STREAMING STARTED ===')
          log.info('Device: %s, Resolution: %dx%d', info.deviceName, info.width, info.height)
          return info
        })
        .catch(function(err) {
          self.running = false
          log.error('=== SCRCPY START FAILED ===')
          log.error('Error: %s', err.message)
          throw err
        })
    }

    /**
     * Stop scrcpy streaming
     */
    ScrcpyClient.prototype.stop = function() {
      var self = this
      log.info('Stopping scrcpy client')

      this.running = false

      if (this.socket) {
        this.socket.destroy()
        this.socket = null
      }

      // Kill scrcpy server on device
      return adb.shell(options.serial, 'pkill -f scrcpy')
        .catch(function() {
          // Try alternative kill command
          return adb.shell(options.serial, 'killall app_process').catch(function() {})
        })
        .finally(function() {
          self.localPort = null
          log.info('Scrcpy client stopped')
        })
    }

    /**
     * Send control message to scrcpy
     */
    ScrcpyClient.prototype.sendControl = function(buffer) {
      if (this.socket && this.running) {
        this.socket.write(buffer)
      }
    }

    return {
      ScrcpyClient: ScrcpyClient,
      jarPath: jarPath,
      remotePath: remotePath
    }
  })
