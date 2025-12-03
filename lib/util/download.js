/**
* Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

var fs = require('fs')
var http = require('http')
var https = require('https')
var url = require('url')

var Promise = require('bluebird')
var temp = require('temp')

var logger = require('./logger')

module.exports = function download(downloadUrl, options) {
  var log = logger.createLogger('util:download')
  
  return new Promise(function(resolve, reject) {
    var path = temp.path(options)
    var timeout = options.timeout || 300000
    var parsedUrl = url.parse(downloadUrl)
    var protocol = parsedUrl.protocol === 'https:' ? https : http
    
    log.info('Downloading from %s to %s', downloadUrl, path)
    
    var req = protocol.get({
      hostname: parsedUrl.hostname
    , port: parsedUrl.port
    , path: parsedUrl.path
    , timeout: timeout
    }, function(res) {
      if (res.statusCode !== 200) {
        reject(new Error('HTTP error ' + res.statusCode))
        return
      }
      
      var writeStream = fs.createWriteStream(path)
      
      res.pipe(writeStream)
      
      writeStream.on('finish', function() {
        writeStream.close()
        log.info('Download complete: %s', path)
        resolve({ path: path })
      })
      
      writeStream.on('error', function(err) {
        fs.unlink(path, function() {})
        reject(err)
      })
    })
    
    req.on('error', function(err) {
      fs.unlink(path, function() {})
      reject(err)
    })
    
    req.on('timeout', function() {
      req.destroy()
      fs.unlink(path, function() {})
      reject(new Error('Download timeout'))
    })
  })
}
