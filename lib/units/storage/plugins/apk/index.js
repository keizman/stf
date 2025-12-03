/**
* Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

var http = require('http')
var url = require('url')
var util = require('util')

var express = require('express')
var request = require('@cypress/request')

var logger = require('../../../../util/logger')
var download = require('../../../../util/download')
var manifest = require('./task/manifest')

module.exports = function(options) {
  var log = logger.createLogger('storage:plugins:apk')
  var app = express()
  var server = http.createServer(app)

  app.set('strict routing', true)
  app.set('case sensitive routing', true)
  app.set('trust proxy', true)

  app.disable('x-powered-by')

  app.get('/s/apk/:id/:name/manifest', function(req, res) {
    var orig = util.format(
      '/s/blob/%s/%s'
    , req.params.id
    , req.params.name
    )
    var downloadUrl = url.resolve(options.storageUrl, orig)
    
    log.info('Downloading APK from %s for manifest extraction', downloadUrl)
    
    download(downloadUrl, {
        dir: options.cacheDir
      , timeout: 300000 // 5 minutes timeout
      })
      .then(function(file) {
        log.info('APK downloaded successfully, size: %d bytes', file.size || 'unknown')
        return manifest(file)
      })
      .then(function(data) {
        log.info('Manifest extracted successfully for "%s"', req.params.id)
        res.status(200)
          .json({
            success: true
          , manifest: data
          })
      })
      .catch(function(err) {
        log.error('Unable to read manifest of "%s": %s', req.params.id, err.message)
        log.error('Error details:', err.stack)
        
        // Return more detailed error information
        var errorMessage = err.message || 'Unknown error'
        var isCorrupted = errorMessage.indexOf('corrupted') !== -1 || 
                         errorMessage.indexOf('incomplete') !== -1 ||
                         errorMessage.indexOf('end of central directory') !== -1
        
        res.status(200)
          .json({
            success: false
          , error: errorMessage
          , corrupted: isCorrupted
          })
      })
  })

  app.get('/s/apk/:id/:name', function(req, res) {
    request(url.resolve(options.storageUrl, util.format(
      '/s/blob/%s/%s'
    , req.params.id
    , req.params.name
    )))
    .pipe(res)
  })

  server.listen(options.port)
  log.info('Listening on port %d', options.port)
}
