/**
 * Scrcpy screen streaming module for STF
 * Provides H.264 video stream using scrcpy-server
 */

var util = require('util')
var Promise = require('bluebird')
var syrup = require('@devicefarmer/stf-syrup')
var WebSocket = require('ws')
var uuid = require('uuid')
var EventEmitter = require('eventemitter3')
var split = require('split')

var logger = require('../../../../util/logger')
var lifecycle = require('../../../../util/lifecycle')
var bannerutil = require('./util/banner')
var FrameParser = require('./util/frameparser')
var FrameConfig = require('./util/frameconfig')
var RiskyStream = require('../../../../util/riskystream')

module.exports = syrup.serial()
  .dependency(require('../../support/adb'))
  .dependency(require('../../resources/scrcpy'))
  .dependency(require('../../resources/minicap'))
  .dependency(require('../util/display'))
  .dependency(require('./options'))
  .define(function(options, adb, scrcpy, minicap, display, screenOptions) {
    var log = logger.createLogger('device:plugins:screen:scrcpy-stream')
    
    log.info('Starting scrcpy screen streaming')
    log.info('NeedScrcpy option is enabled')

    // Scrcpy client instance
    var scrcpyClient = null
    var clientStarted = false
    
    // Minicap fallback support
    var minicapProc = null
    var useFallback = false

    // Keyframe cache for new clients
    var keyframeCache = {
      sps: null,
      pps: null,
      idr: null
    }

    /**
     * Parse NAL unit type from H.264 data
     */
    function parseNALUnits(data) {
      var units = []
      var i = 0
      var len = data.length

      while (i < len - 4) {
        // Look for start code (0x00000001 or 0x000001)
        if (data[i] === 0 && data[i + 1] === 0) {
          var startCodeLen = 0
          if (data[i + 2] === 0 && data[i + 3] === 1) {
            startCodeLen = 4
          } else if (data[i + 2] === 1) {
            startCodeLen = 3
          }

          if (startCodeLen > 0) {
            var nalType = data[i + startCodeLen] & 0x1f
            units.push({
              type: nalType,
              offset: i,
              startCodeLen: startCodeLen
            })
            i += startCodeLen + 1
            continue
          }
        }
        i++
      }

      return units
    }

    /**
     * Extract NAL unit data from buffer
     */
    function extractNALUnit(data, startOffset, nextOffset) {
      var end = nextOffset !== undefined ? nextOffset : data.length
      return Buffer.from(data.slice(startOffset, end))
    }

    /**
     * Cache keyframes from H.264 data
     */
    function cacheKeyframes(data) {
      var units = parseNALUnits(data)
      
      for (var i = 0; i < units.length; i++) {
        var unit = units[i]
        var nextOffset = (i + 1 < units.length) ? units[i + 1].offset : data.length
        var nalData = extractNALUnit(data, unit.offset, nextOffset)

        switch (unit.type) {
          case 7: // SPS
            keyframeCache.sps = nalData
            log.info('Cached SPS (%d bytes)', nalData.length)
            break
          case 8: // PPS
            keyframeCache.pps = nalData
            log.info('Cached PPS (%d bytes)', nalData.length)
            break
          case 5: // IDR (keyframe)
            keyframeCache.idr = nalData
            break
        }
      }
    }

    /**
     * Get cached keyframes for new client
     */
    function getCachedKeyframes() {
      var frames = []
      if (keyframeCache.sps) {
        frames.push(keyframeCache.sps)
      }
      if (keyframeCache.pps) {
        frames.push(keyframeCache.pps)
      }
      if (keyframeCache.idr) {
        frames.push(keyframeCache.idr)
      }
      return frames
    }

    /**
     * ScrcpyFrameProducer - manages scrcpy streaming
     */
    function ScrcpyFrameProducer() {
      EventEmitter.call(this)
      this.running = false
      this.deviceInfo = null
    }

    util.inherits(ScrcpyFrameProducer, EventEmitter)

    ScrcpyFrameProducer.prototype.start = function() {
      var self = this

      if (this.running) {
        return Promise.resolve(this.deviceInfo)
      }

      log.info('Starting scrcpy frame producer')
      this.running = true

      // Clear keyframe cache
      keyframeCache.sps = null
      keyframeCache.pps = null
      keyframeCache.idr = null

      // Create scrcpy client with optimized settings
      scrcpyClient = new scrcpy.ScrcpyClient({
        maxSize: 0,           // Use device resolution
        bitRate: 8000000,     // 8 Mbps for good quality
        maxFps: 60,           // Up to 60 fps
        tunnelDelay: 3000,    // Wait 3 seconds for server socket
        connectRetries: 5,    // Retry connection 5 times
        sendFrameMeta: false  // Don't send frame meta for raw H264
      })

      // Get a unique port for this device
      var localPort = 27183 + Math.floor(Math.random() * 1000)

      return scrcpyClient.start(localPort)
        .then(function(deviceInfo) {
          self.deviceInfo = deviceInfo
          log.info('Scrcpy started: %s %dx%d', 
            deviceInfo.deviceName, deviceInfo.width, deviceInfo.height)

          // Forward H.264 data events
          scrcpyClient.on('data', function(data) {
            // Cache keyframes for new clients
            cacheKeyframes(data)
            self.emit('data', data)
          })

          scrcpyClient.on('error', function(err) {
            log.error('Scrcpy error: %s', err.message)
            self.emit('error', err)
          })

          scrcpyClient.on('close', function() {
            log.info('Scrcpy connection closed')
            self.running = false
            self.emit('close')
          })

          self.emit('start', deviceInfo)
          return deviceInfo
        })
        .catch(function(err) {
          self.running = false
          log.error('Failed to start scrcpy: %s', err.message)
          throw err
        })
    }

    ScrcpyFrameProducer.prototype.stop = function() {
      log.info('Stopping scrcpy frame producer')
      this.running = false

      if (scrcpyClient) {
        return scrcpyClient.stop()
      }

      return Promise.resolve()
    }

    ScrcpyFrameProducer.prototype.isRunning = function() {
      return this.running
    }

    /**
     * Create WebSocket server
     */
    function createServer() {
      log.info('Starting scrcpy WebSocket server on port %d', screenOptions.publicPort)

      var wss = new WebSocket.Server({
        port: screenOptions.publicPort,
        perMessageDeflate: false
      })

      var listeningListener, errorListener

      return new Promise(function(resolve, reject) {
        listeningListener = function() {
          return resolve(wss)
        }

        errorListener = function(err) {
          return reject(err)
        }

        wss.on('listening', listeningListener)
        wss.on('error', errorListener)
      })
      .finally(function() {
        wss.removeListener('listening', listeningListener)
        wss.removeListener('error', errorListener)
      })
    }

    return createServer()
      .then(function(wss) {
        log.info('Scrcpy WebSocket server created')

        var frameProducer = new ScrcpyFrameProducer()
        var clients = new Map()  // Track connected clients
        var producerStarted = false

        /**
         * Start the frame producer when first client connects
         */
        function ensureProducerStarted() {
          if (producerStarted) {
            return Promise.resolve(frameProducer.deviceInfo)
          }

          producerStarted = true
          return frameProducer.start()
        }

        /**
         * Stop the frame producer when all clients disconnect
         */
        function maybeStopProducer() {
          if (clients.size === 0 && producerStarted) {
            log.info('All clients disconnected, stopping producer')
            producerStarted = false
            frameProducer.stop()
          }
        }

        /**
         * Send cached keyframes to new client
         */
        function sendCachedKeyframes(sendFrame) {
          var frames = getCachedKeyframes()
          if (frames.length > 0) {
            log.info('Sending %d cached keyframes to new client', frames.length)
            frames.forEach(function(frame) {
              sendFrame(frame).catch(function(err) {
                log.warn('Failed to send cached keyframe: %s', err.message)
              })
            })
          }
        }

        /**
         * Start minicap fallback for a client
         */
        var minicapOutput = null
        var minicapSocket = null
        var minicapParser = null
        var minicapStarted = false
        
        function startMinicapFallback(clientId) {
          if (minicapStarted) {
            log.info('Minicap already running, skipping start')
            return Promise.resolve()
          }
          
          log.info('Starting minicap fallback for client %s', clientId)
          minicapStarted = true
          
          var frameConfig = new FrameConfig(display.properties, display.properties)
          
          // Try minicap-apk first (more compatible), then minicap-bin
          var grabbers = ['minicap-apk', 'minicap-bin']
          if (options.screenGrabber) {
            // Put user's preference first
            grabbers = [options.screenGrabber].concat(
              grabbers.filter(function(g) { return g !== options.screenGrabber })
            )
          }
          
          // Build minicap command args like stream.js does
          var args
          if (options.screenFrameRate <= 0.0) {
            args = util.format('-S -Q %d -P %s', 
              options.screenJpegQuality || 80, 
              frameConfig.toString())
          } else {
            args = util.format('-S -r %d -Q %d -P %s', 
              options.screenFrameRate || 30, 
              options.screenJpegQuality || 80, 
              frameConfig.toString())
          }
          
          function tryGrabber(index) {
            if (index >= grabbers.length) {
              return Promise.reject(new Error('All minicap grabbers failed'))
            }
            var grabber = grabbers[index]
            log.info('Trying minicap grabber: %s (attempt %d/%d)', grabber, index + 1, grabbers.length)
            log.info('Starting minicap with grabber=%s args=%s', grabber, args)
          
            return minicap.run(grabber, args)
              .timeout(10000)
              .then(function(out) {
                if (!out) {
                  throw new Error('Minicap returned undefined output')
                }
                minicapOutput = new RiskyStream(out)
                  .on('unexpectedEnd', function() {
                    log.warn('Minicap output stream ended unexpectedly')
                    minicapStarted = false
                  })
                
                // Wait for minicap to output PID before connecting
                return new Promise(function(resolve, reject) {
                  var pidReceived = false
                  var timeout = setTimeout(function() {
                    if (!pidReceived) {
                      reject(new Error('Timeout waiting for minicap PID'))
                    }
                  }, 10000)
                  
                  out.pipe(split()).on('data', function(line) {
                    var trimmed = line.toString().trim()
                    if (trimmed) {
                      log.info('minicap says: "%s"', trimmed)
                      
                      // Wait for PID output before connecting
                      if (/^PID: \d+$/.test(trimmed) || /Listening on socket/.test(trimmed)) {
                        if (!pidReceived) {
                          pidReceived = true
                          clearTimeout(timeout)
                          // Give it a small delay after PID
                          setTimeout(resolve, 100)
                        }
                      }
                    }
                  })
                  
                  out.on('error', function(err) {
                    clearTimeout(timeout)
                    reject(err)
                  })
                })
              })
              .then(function() {
                log.info('Connecting to minicap service')
                return tryConnectMinicap(5, 100)
              })
              .then(function(socket) {
                minicapSocket = new RiskyStream(socket)
                  .on('unexpectedEnd', function() {
                    log.warn('Minicap socket ended unexpectedly')
                    minicapStarted = false
                  })
                
                minicapParser = new FrameParser()
                // Use bannerutil.read which returns a Promise
                return bannerutil.read(minicapSocket.stream)
              })
              .then(function(banner) {
                log.info('Minicap fallback started successfully: %dx%d', banner.virtualWidth, banner.virtualHeight)
                minicapStarted = true  // Mark as started after successful connection
                
                // Notify clients that we switched to JPEG mode
                clients.forEach(function(client, id) {
                  client.send('start ' + JSON.stringify({
                    type: 'jpeg',
                    width: banner.virtualWidth,
                    height: banner.virtualHeight,
                    quirks: banner.quirks || { dumb: false, alwaysUpright: false, tear: false }
                  })).catch(function() {})
                })
                
                readMinicapFrames(minicapSocket.stream)
                return banner
              })
              .catch(function(err) {
                log.warn('Grabber %s failed: %s, trying next...', grabber, err.message)
                minicapStarted = false
                return tryGrabber(index + 1)
              })
          }
          
          return tryGrabber(0)
            .catch(function(err) {
              log.error('All minicap grabbers failed: %s', err.message)
              minicapStarted = false
              // Notify client that fallback failed
              clients.forEach(function(client, id) {
                client.send(JSON.stringify({ error: 'Minicap fallback failed: ' + err.message }))
                  .catch(function() {})
              })
              throw err
            })
        }
        
        function tryConnectMinicap(times, delay) {
          return adb.openLocal(options.serial, 'localabstract:minicap')
            .timeout(10000)
            .catch(function(err) {
              if (/closed/.test(err.message) && times > 1) {
                return Promise.delay(delay)
                  .then(function() {
                    return tryConnectMinicap(times - 1, delay * 2)
                  })
              }
              return Promise.reject(err)
            })
        }
        
        function readMinicapFrames(stream) {
          stream.on('readable', function() {
            var chunk = stream.read()
            if (!chunk) return
            
            minicapParser.push(chunk)
            
            var frame
            while ((frame = minicapParser.nextFrame())) {
              // Send JPEG frame to all clients
              clients.forEach(function(client, id) {
                client.send(frame).catch(function(err) {
                  log.warn('Failed to send minicap frame to %s: %s', id, err.message)
                })
              })
            }
          })
        }

        // Handle incoming WebSocket connections
        wss.on('connection', function(ws) {
          var id = uuid.v4()
          var pingTimer
          var subscribed = false

          log.info('New WebSocket connection: %s', id)

          function send(message, opts) {
            return new Promise(function(resolve, reject) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(message, opts, function(err) {
                  return err ? reject(err) : resolve()
                })
              } else {
                resolve()
              }
            })
          }

          function sendStartInfo(deviceInfo) {
            // Send start message with stream info for H.264
            var info = {
              type: 'h264',
              width: deviceInfo.width,
              height: deviceInfo.height,
              deviceName: deviceInfo.deviceName
            }
            return send('start ' + JSON.stringify(info))
          }

          function sendPing() {
            return send('ping')
          }

          function sendFrame(data) {
            return send(data, { binary: true })
          }

          // Setup ping interval
          pingTimer = setInterval(sendPing, options.screenPingInterval)

          // Handle messages from client
          ws.on('message', function(data) {
            var message = data.toString()

            if (message === 'on' || message === 'on:h264') {
              // Client requests H.264 stream (WebCodecs supported)
              if (!subscribed) {
                subscribed = true
                clients.set(id, { send: sendFrame, useH264: true })
                log.info('Client %s connected, requesting H.264 stream', id)

                ensureProducerStarted()
                  .then(function(deviceInfo) {
                    if (deviceInfo) {
                      sendStartInfo(deviceInfo)
                      // Send cached keyframes to new client
                      sendCachedKeyframes(sendFrame)
                    }
                  })
                  .catch(function(err) {
                    log.error('Failed to start producer: %s', err.message)
                    send(JSON.stringify({ error: err.message }))
                  })
              }
            } else if (message === 'on:jpeg') {
              // Client requests JPEG stream (WebCodecs not supported)
              if (!subscribed) {
                subscribed = true
                clients.set(id, { send: sendFrame, useH264: false })
                useFallback = true
                log.info('Client %s connected, requesting JPEG stream (no WebCodecs)', id)

                if (minicapStarted) {
                  // Minicap already running, just notify client
                  log.info('Minicap already running, notifying client')
                  send('start ' + JSON.stringify({
                    type: 'jpeg',
                    width: display.properties.width,
                    height: display.properties.height,
                    quirks: { dumb: false, alwaysUpright: false, tear: false }
                  }))
                } else {
                  // Start minicap directly (no scrcpy)
                  startMinicapFallback(id)
                }
              }
            } else if (message === 'off') {
              subscribed = false
              clients.delete(id)
              maybeStopProducer()
            }
            // Note: 'size' messages are ignored for scrcpy since it handles resolution internally
          })

          ws.on('close', function() {
            log.info('WebSocket closed: %s', id)
            clearInterval(pingTimer)
            clients.delete(id)
            maybeStopProducer()
          })

          ws.on('error', function(err) {
            log.error('WebSocket error for %s: %s', id, err.message)
            clearInterval(pingTimer)
            clients.delete(id)
            maybeStopProducer()
          })
        })

        // Forward H.264 data to all connected clients
        var dataChunkCount = 0
        frameProducer.on('data', function(data) {
          dataChunkCount++
          if (dataChunkCount <= 10 || dataChunkCount % 100 === 0) {
            log.info('Broadcasting H264 data chunk #%d (%d bytes) to %d clients', 
              dataChunkCount, data.length, clients.size)
          }
          clients.forEach(function(client, id) {
            client.send(data).catch(function(err) {
              log.warn('Failed to send to client %s: %s', id, err.message)
            })
          })
        })

        frameProducer.on('error', function(err) {
          log.error('Frame producer error: %s', err.message)
        })

        // Cleanup on shutdown
        lifecycle.observe(function() {
          wss.close()
        })

        lifecycle.observe(function() {
          frameProducer.stop()
        })

        return frameProducer
      })
  })
