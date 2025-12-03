/**
* Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

var http = require('http')
var util = require('util')
var path = require('path')
var crypto = require('crypto')

var express = require('express')
var bodyParser = require('body-parser')
var formidable = require('formidable')
var Promise = require('bluebird')

var logger = require('../../util/logger')
var Storage = require('../../util/storage')
var requtil = require('../../util/requtil')
var download = require('../../util/download')
var bundletool = require('../../util/bundletool')

module.exports = function(options) {
  var log = logger.createLogger('storage:temp')
  var app = express()
  var server = http.createServer(app)
  var storage = new Storage()

  app.set('strict routing', true)
  app.set('case sensitive routing', true)
  app.set('trust proxy', true)

  app.use(bodyParser.json())

  app.disable('x-powered-by')

  storage.on('timeout', function(id) {
    log.info('Cleaning up inactive resource "%s"', id)
  })

  app.post('/s/download/:plugin', requtil.validators.tempUrlValidator, function(req, res) {
    requtil.validate(req)
      .then(function() {
        return download(req.body.url, {
          dir: options.cacheDir
        })
      })
      .then(function(file) {
        return {
          id: storage.store(file)
        , name: file.name
        }
      })
      .then(function(file) {
        var plugin = req.params.plugin
        res.status(201)
          .json({
            success: true
          , resource: {
              date: new Date()
            , plugin: plugin
            , id: file.id
            , name: file.name
            , href: util.format(
                '/s/%s/%s%s'
              , plugin
              , file.id
              , file.name ? util.format('/%s', path.basename(file.name)) : ''
              )
            }
          })
      })
      .catch(requtil.ValidationError, function(err) {
        res.status(400)
          .json({
            success: false
          , error: 'ValidationError'
          , validationErrors: err.errors
          })
      })
      .catch(function(err) {
        log.error('Error storing resource', err.stack)
        res.status(500)
          .json({
            success: false
          , error: 'ServerError'
          })
      })
  })

  app.post('/s/upload/:plugin', function(req, res) {
    var form = new formidable.IncomingForm({
      maxFileSize: options.maxFileSize
    })
    if (options.saveDir) {
      form.uploadDir = options.saveDir
    }
    form.on('fileBegin', function(name, file) {
      if (/\.aab$/.test(file.name)) {
        file.isAab = true
      }
      var md5 = crypto.createHash('md5')
      file.name = md5.update(file.name).digest('hex')
    })
    Promise.promisify(form.parse, form)(req)
      .spread(function(fields, files) {
        return Object.keys(files).map(function(field) {
          var file = files[field]
          var id = storage.store(file)
          log.info('Uploaded "%s" to "%s" with ID "%s"', file.name, file.path, id)
          log.info('File stored in memory, current storage has %d files', Object.keys(storage.files).length)
          return {
            field: field
          , id: id
          , name: file.name
          , path: file.path
          , isAab: file.isAab
          }
        })
      })
      .then(function(storedFiles) {
        return Promise.all(storedFiles.map(function(file) {
            return bundletool({
              bundletoolPath: options.bundletoolPath
            , keystore: options.keystore
            , file: file
            })
          })
        )
      })
      .then(function(storedFiles) {
        res.status(201)
          .json({
            success: true
          , resources: (function() {
              var mapped = Object.create(null)
              storedFiles.forEach(function(file) {
                var plugin = req.params.plugin
                mapped[file.field] = {
                  date: new Date()
                , plugin: plugin
                , id: file.id
                , name: file.name
                , href: util.format(
                    '/s/%s/%s%s'
                  , plugin
                  , file.id
                  , file.name ?
                      util.format('/%s', path.basename(file.name)) :
                      ''
                  )
                }
              })
              return mapped
            })()
          })
      })
      .catch(function(err) {
        log.error('Error storing resource', err.stack)
        res.status(500)
          .json({
            success: false
          , error: 'ServerError'
          })
      })
  })

  app.get('/s/blob/:id/:name', function(req, res) {
    var file = storage.retrieve(req.params.id)
    log.info('Blob request for id "%s", name "%s", found: %s', 
      req.params.id, req.params.name, file ? 'yes' : 'no')
    
    if (file) {
      log.info('Serving file from path "%s" (type: %s)', file.path, file.type || 'unknown')
      
      // Verify file exists before serving
      var fs = require('fs')
      if (!fs.existsSync(file.path)) {
        log.error('File no longer exists at path "%s"', file.path)
        res.sendStatus(404)
        return
      }
      
      if (typeof req.query.download !== 'undefined') {
        res.set('Content-Disposition',
          'attachment; filename="' + path.basename(file.name) + '"')
      }
      res.set('Content-Type', file.type || 'application/octet-stream')
      res.sendFile(file.path, function(err) {
        if (err) {
          log.error('Error sending file "%s": %s', file.path, err.message)
        }
      })
    }
    else {
      log.warn('File not found in storage for id "%s" (may have expired or not uploaded yet)', req.params.id)
      log.info('Current storage has %d files', Object.keys(storage.files).length)
      res.sendStatus(404)
    }
  })

  // Cleanup endpoint - delete temp file after install completes
  app.delete('/s/blob/:id/cleanup', function(req, res) {
    var id = req.params.id
    log.info('Cleanup request for blob id "%s"', id)
    
    var file = storage.retrieve(id)
    if (file) {
      storage.remove(id)
      log.info('Blob "%s" cleaned up successfully, remaining files: %d', id, Object.keys(storage.files).length)
      res.status(200).json({ success: true, message: 'Cleaned up' })
    } else {
      log.warn('Blob "%s" not found for cleanup (may already be cleaned)', id)
      res.status(200).json({ success: true, message: 'Already cleaned or not found' })
    }
  })

  server.listen(options.port)
  log.info('Listening on port %d', options.port)
}
