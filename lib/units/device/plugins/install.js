//
// Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
//

var stream = require('stream')
var url = require('url')
var util = require('util')
var fs = require('fs')
var path = require('path')
var os = require('os')

var syrup = require('@devicefarmer/stf-syrup')
var request = require('@cypress/request')
var Promise = require('bluebird')

var logger = require('../../../util/logger')
var wire = require('../../../wire')
var wireutil = require('../../../wire/util')
var promiseutil = require('../../../util/promiseutil')

// The error codes are available at https://github.com/android/
// platform_frameworks_base/blob/master/core/java/android/content/
// pm/PackageManager.java
function InstallationError(err) {
  return err.code && /^INSTALL_/.test(err.code)
}

module.exports = syrup.serial()
  .dependency(require('../support/adb'))
  .dependency(require('../support/router'))
  .dependency(require('../support/push'))
  .define(function(options, adb, router, push) {
    var log = logger.createLogger('device:plugins:install')

    router.on(wire.InstallMessage, function(channel, message) {
      var manifest = JSON.parse(message.manifest)
      var pkg = manifest.package
      var isPushOnly = manifest.isPushOnly === true
      var originalFileName = manifest.originalFileName || 'file'
      var isApkFile = /\.apk$/i.test(originalFileName)

      if (isPushOnly) {
        log.info('Pushing file "%s" from "%s"', originalFileName, message.href)
      } else {
        log.info('Installing package "%s" from "%s"', pkg, message.href)
      }

      var reply = wireutil.reply(options.serial)
      var localTempFile = null

      function sendProgress(data, progress) {
        push.send([
          channel
        , reply.progress(data, progress)
        ])
      }

      // Download file from server to local temp
      function downloadToLocal() {
        return new Promise(function(resolve, reject) {
          var tempFile = path.join(os.tmpdir(), 'stf_install_' + Date.now() + '_' + originalFileName)
          var writeStream = fs.createWriteStream(tempFile)
          var downloadUrl = url.resolve(options.storageUrl, message.href)
          
          log.info('Downloading from %s to %s', downloadUrl, tempFile)
          
          var req = request({
            url: downloadUrl
          })
          
          var contentLength = null
          req.on('response', function(res) {
            contentLength = parseInt(res.headers['content-length'], 10)
          })
          
          var bytesReceived = 0
          req.on('data', function(chunk) {
            bytesReceived += chunk.length
            if (contentLength) {
              sendProgress('downloading', 25 * (bytesReceived / contentLength))
            }
          })
          
          req.on('error', function(err) {
            reject(err)
          })
          
          writeStream.on('finish', function() {
            localTempFile = tempFile
            log.info('Downloaded to local temp: %s', tempFile)
            resolve(tempFile)
          })
          
          writeStream.on('error', function(err) {
            reject(err)
          })
          
          req.pipe(writeStream)
        })
      }

      // Push file to device
      function pushToDevice(localPath, devicePath) {
        var fileSize = fs.statSync(localPath).size
        log.info('Pushing file %s (%d bytes) to %s', localPath, fileSize, devicePath)
        
        return adb.push(options.serial, fs.createReadStream(localPath), devicePath)
          .timeout(300000) // 5 minutes timeout for large files
          .then(function(transfer) {
            var resolver = Promise.defer()
            var resolved = false

            function progressListener(stats) {
              sendProgress(
                'pushing_file'
              , 25 + 25 * Math.max(0, Math.min(1, stats.bytesTransferred / fileSize))
              )
            }

            function errorListener(err) {
              if (!resolved) {
                resolved = true
                resolver.reject(err)
              }
            }

            function endListener() {
              if (!resolved) {
                resolved = true
                log.info('Push completed, waiting for sync...')
                // Wait a bit for file to sync on device
                setTimeout(function() {
                  resolver.resolve(devicePath)
                }, 500)
              }
            }

            transfer.on('progress', progressListener)
            transfer.on('error', errorListener)
            transfer.on('end', endListener)

            return resolver.promise.finally(function() {
              transfer.removeListener('progress', progressListener)
              transfer.removeListener('error', errorListener)
              transfer.removeListener('end', endListener)
            })
          })
      }

      // Cleanup local temp file
      function cleanupLocalFile() {
        if (localTempFile && fs.existsSync(localTempFile)) {
          try {
            fs.unlinkSync(localTempFile)
            log.info('Cleaned up local temp file: %s', localTempFile)
          } catch (err) {
            log.warn('Failed to cleanup local temp file %s: %s', localTempFile, err.message)
          }
        }
      }

      // Cleanup device temp file
      function cleanupDeviceFile(filePath) {
        return adb.shell(options.serial, ['rm', '-f', filePath])
          .then(function(output) {
            return adb.util.readAll(output)
          })
          .then(function() {
            log.info('Cleaned up device temp file: %s', filePath)
          })
          .catch(function(err) {
            log.warn('Failed to cleanup device temp file %s: %s', filePath, err.message)
          })
      }

      // Notify server to cleanup temp storage
      function notifyServerCleanup() {
        // Extract blob ID from href (e.g., /s/apk/UUID/filename)
        var hrefParts = message.href.split('/')
        if (hrefParts.length >= 4) {
          var blobId = hrefParts[3]
          var cleanupUrl = url.resolve(options.storageUrl, '/s/blob/' + blobId + '/cleanup')
          request.del(cleanupUrl, function(err) {
            if (err) {
              log.warn('Failed to notify server cleanup: %s', err.message)
            } else {
              log.info('Notified server to cleanup blob: %s', blobId)
            }
          })
        }
      }

      // Progress 0%
      sendProgress(isPushOnly ? 'pushing_file' : 'downloading', 0)

      if (isPushOnly) {
        // Non-APK file: push to /data/local/tmp
        var targetPath = '/data/local/tmp/' + originalFileName
        
        downloadToLocal()
          .then(function(localPath) {
            return pushToDevice(localPath, targetPath)
          })
          .then(function(devicePath) {
            log.info('File pushed successfully to %s', devicePath)
            sendProgress('push_complete', 100)
            cleanupLocalFile()
            notifyServerCleanup()
            push.send([
              channel
            , reply.okay('PUSH_SUCCEEDED')
            ])
          })
          .catch(Promise.TimeoutError, function(err) {
            log.error('Push of file "%s" failed (timeout)', originalFileName, err.stack)
            cleanupLocalFile()
            push.send([
              channel
            , reply.fail('PUSH_ERROR_TIMEOUT')
            ])
          })
          .catch(function(err) {
            log.error('Push of file "%s" failed', originalFileName, err.stack)
            cleanupLocalFile()
            push.send([
              channel
            , reply.fail('PUSH_ERROR_UNKNOWN')
            ])
          })
      } else if (isApkFile) {
        // APK file: push to device then use pm install -r -d -t
        var apkTarget = '/data/local/tmp/_install_' + Date.now() + '.apk'
        
        downloadToLocal()
          .then(function(localPath) {
            sendProgress('pushing_app', 30)
            log.info('Pushing APK to device: %s -> %s', localPath, apkTarget)
            return pushToDevice(localPath, apkTarget)
          })
          .then(function(deviceApkPath) {
            var start = 50
            var end = 90
            var guesstimate = start

            sendProgress('installing_app', guesstimate)
            log.info('Installing APK using pm install -r -d -t: %s', deviceApkPath)
            
            return promiseutil.periodicNotify(
                adb.shell(options.serial, ['pm', 'install', '-r', '-d', '-t', deviceApkPath])
                  .then(function(output) {
                    return adb.util.readAll(output)
                  })
                  .then(function(output) {
                    var result = output.toString().trim()
                    log.info('Install result: %s', result)
                    if (result.indexOf('Success') !== -1) {
                      return result
                    }
                    
                    if (result.indexOf('INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES') !== -1 ||
                        result.indexOf('INSTALL_FAILED_VERSION_DOWNGRADE') !== -1) {
                      log.info('Uninstalling "%s" first due to inconsistent certificates', pkg)
                      return adb.uninstall(options.serial, pkg)
                        .timeout(15000)
                        .then(function() {
                          return adb.shell(options.serial, ['pm', 'install', '-r', '-d', '-t', deviceApkPath])
                        })
                        .then(function(output) {
                          return adb.util.readAll(output)
                        })
                        .then(function(output) {
                          var result = output.toString().trim()
                          if (result.indexOf('Success') !== -1) {
                            return result
                          }
                          var err = new Error(result)
                          err.code = result
                          throw err
                        })
                    }
                    
                    var err = new Error(result)
                    err.code = result
                    throw err
                  })
                  .timeout(60000 * 5)
              , 250
              )
              .progressed(function() {
                guesstimate = Math.min(
                  end
                , guesstimate + 1.5 * (end - guesstimate) / (end - start)
                )
                sendProgress('installing_app', guesstimate)
              })
              .then(function() {
                // Cleanup device temp APK
                return cleanupDeviceFile(apkTarget)
              })
          })
          .then(function() {
            if (message.launch) {
              if (manifest.application && manifest.application.launcherActivities && 
                  manifest.application.launcherActivities.length) {
                var activityName = manifest.application.launcherActivities[0].name

                if (activityName.indexOf('.') === -1) {
                  activityName = util.format('.%s', activityName)
                }

                var launchActivity = {
                  action: 'android.intent.action.MAIN'
                , component: util.format('%s/%s', pkg, activityName)
                , category: ['android.intent.category.LAUNCHER']
                , flags: 0x10200000
                }

                log.info('Launching activity with action "%s" on component "%s"'
                , launchActivity.action
                , launchActivity.component
                )
                sendProgress('launching_app', 95)
                return adb.startActivity(options.serial, launchActivity)
                  .timeout(30000)
              }
            }
          })
          .then(function() {
            cleanupLocalFile()
            notifyServerCleanup()
            push.send([
              channel
            , reply.okay('INSTALL_SUCCEEDED')
            ])
          })
          .catch(Promise.TimeoutError, function(err) {
            log.error('Installation of package "%s" failed (timeout)', pkg, err.stack)
            cleanupLocalFile()
            push.send([
              channel
            , reply.fail('INSTALL_ERROR_TIMEOUT')
            ])
          })
          .catch(InstallationError, function(err) {
            log.important('Tried to install package "%s", got "%s"', pkg, err.code)
            cleanupLocalFile()
            push.send([
              channel
            , reply.fail(err.code)
            ])
          })
          .catch(function(err) {
            log.error('Installation of package "%s" failed', pkg, err.stack)
            cleanupLocalFile()
            push.send([
              channel
            , reply.fail('INSTALL_ERROR_UNKNOWN')
            ])
          })
      } else {
        // Non-APK file treated as app (AAB etc): push then pm install
        var apkTarget = '/data/local/tmp/_app.apk'
        
        downloadToLocal()
          .then(function(localPath) {
            return pushToDevice(localPath, apkTarget)
          })
          .then(function(apk) {
            var start = 50
            var end = 90
            var guesstimate = start

            sendProgress('installing_app', guesstimate)
            
            return promiseutil.periodicNotify(
                adb.shell(options.serial, ['pm', 'install', '-r', '-d', '-t', apk])
                  .then(function(output) {
                    return adb.util.readAll(output)
                  })
                  .then(function(output) {
                    var result = output.toString().trim()
                    if (result.indexOf('Success') !== -1) {
                      return result
                    }
                    
                    if (result.indexOf('INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES') !== -1 ||
                        result.indexOf('INSTALL_FAILED_VERSION_DOWNGRADE') !== -1) {
                      log.info('Uninstalling "%s" first due to inconsistent certificates', pkg)
                      return adb.uninstall(options.serial, pkg)
                        .timeout(15000)
                        .then(function() {
                          return adb.shell(options.serial, ['pm', 'install', '-r', '-d', '-t', apk])
                        })
                        .then(function(output) {
                          return adb.util.readAll(output)
                        })
                        .then(function(output) {
                          var result = output.toString().trim()
                          if (result.indexOf('Success') !== -1) {
                            return result
                          }
                          var err = new Error(result)
                          err.code = result
                          throw err
                        })
                    }
                    
                    var err = new Error(result)
                    err.code = result
                    throw err
                  })
                  .timeout(60000 * 5)
              , 250
              )
              .progressed(function() {
                guesstimate = Math.min(
                  end
                , guesstimate + 1.5 * (end - guesstimate) / (end - start)
                )
                sendProgress('installing_app', guesstimate)
              })
          })
          .then(function() {
            if (message.launch) {
              if (manifest.application && manifest.application.launcherActivities &&
                  manifest.application.launcherActivities.length) {
                var activityName = manifest.application.launcherActivities[0].name

                if (activityName.indexOf('.') === -1) {
                  activityName = util.format('.%s', activityName)
                }

                var launchActivity = {
                  action: 'android.intent.action.MAIN'
                , component: util.format('%s/%s', pkg, activityName)
                , category: ['android.intent.category.LAUNCHER']
                , flags: 0x10200000
                }

                log.info('Launching activity with action "%s" on component "%s"'
                , launchActivity.action
                , launchActivity.component
                )
                sendProgress('launching_app', 90)
                return adb.startActivity(options.serial, launchActivity)
                  .timeout(30000)
              }
            }
          })
          .then(function() {
            // Cleanup temp APK file after successful install
            return cleanupDeviceFile(apkTarget)
              .then(function() {
                cleanupLocalFile()
                notifyServerCleanup()
                push.send([
                  channel
                , reply.okay('INSTALL_SUCCEEDED')
                ])
              })
          })
          .catch(Promise.TimeoutError, function(err) {
            log.error('Installation of package "%s" failed', pkg, err.stack)
            cleanupDeviceFile(apkTarget)
            cleanupLocalFile()
            push.send([
              channel
            , reply.fail('INSTALL_ERROR_TIMEOUT')
            ])
          })
          .catch(InstallationError, function(err) {
            log.important('Tried to install package "%s", got "%s"', pkg, err.code)
            cleanupDeviceFile(apkTarget)
            cleanupLocalFile()
            push.send([
              channel
            , reply.fail(err.code)
            ])
          })
          .catch(function(err) {
            log.error('Installation of package "%s" failed', pkg, err.stack)
            cleanupDeviceFile(apkTarget)
            cleanupLocalFile()
            push.send([
              channel
            , reply.fail('INSTALL_ERROR_UNKNOWN')
            ])
          })
      }
    })

    router.on(wire.UninstallMessage, function(channel, message) {
      log.info('Uninstalling "%s"', message.packageName)

      var reply = wireutil.reply(options.serial)

      adb.uninstall(options.serial, message.packageName)
        .then(function() {
          push.send([
            channel
          , reply.okay('success')
          ])
        })
        .catch(function(err) {
          log.error('Uninstallation failed', err.stack)
          push.send([
            channel
          , reply.fail('fail')
          ])
        })
    })
  })
