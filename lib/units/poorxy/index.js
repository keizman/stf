/**
* Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

var http = require('http')

var express = require('express')
var httpProxy = require('http-proxy')

var logger = require('../../util/logger')

module.exports = function(options) {
  var log = logger.createLogger('poorxy')
  var app = express()
  var server = http.createServer(app)
  var proxy = httpProxy.createProxyServer({
    proxyTimeout: 300000  // 5 minutes timeout for large file uploads
  , timeout: 300000
  })

  proxy.on('error', function(err, req, res) {
    log.error('Proxy error for %s %s: %s', req.method, req.url, err.message)
    log.error('Proxy error details:', err.stack)
    
    // Send error response if response is still writable
    if (res && !res.headersSent) {
      res.writeHead(502, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({
        success: false
      , error: 'Proxy error: ' + err.message
      }))
    }
  })

  app.set('strict routing', true)
  app.set('case sensitive routing', true)
  app.set('trust proxy', true)

  app.disable('x-powered-by')

  ;['/static/auth/*', '/auth/*'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.authUrl
      })
    })
  })

  ;['/s/image/*'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.storagePluginImageUrl
      })
    })
  })

  ;['/s/apk/*'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.storagePluginApkUrl
      })
    })
  })

  ;['/s/*'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.storageUrl
      })
    })
  })

  ;['/api/*'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.apiUrl
      })
    })
  })
  app.use(function(req, res) {
    proxy.web(req, res, {
      target: options.appUrl
    })
  })

  server.listen(options.port)
  log.info('Listening on port %d', options.port)
}
