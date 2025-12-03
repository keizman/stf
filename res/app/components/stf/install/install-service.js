var EventEmitter = require('eventemitter3')
var Promise = require('bluebird')
Promise.longStackTraces()

module.exports = function InstallService(
  $rootScope
, $http
, $filter
, StorageService
, AppState
) {
  var installService = Object.create(null)

  function Installation(state) {
    this.progress = 0
    this.state = state
    this.settled = false
    this.success = false
    this.error = null
    this.href = null
    this.manifest = null
    this.launch = true
  }

  Installation.prototype = Object.create(EventEmitter.prototype)
  Installation.prototype.constructor = Installation

  Installation.prototype.apply = function($scope) {
    function changeListener() {
      $scope.safeApply()
    }

    this.on('change', changeListener)

    $scope.$on('$destroy', function() {
      this.removeListener('change', changeListener)
    }.bind(this))

    return this
  }

  Installation.prototype.update = function(progress, state) {
    this.progress = Math.floor(progress)
    this.state = state
    this.emit('change')
  }

  Installation.prototype.okay = function(state) {
    this.settled = true
    this.progress = 100
    this.success = true
    this.state = state
    this.emit('change')
  }

  Installation.prototype.fail = function(err) {
    this.settled = true
    this.progress = 100
    this.success = false
    this.error = err
    this.emit('change')
  }

  installService.installUrl = function(control, url) {
    var installation = new Installation('downloading')
    $rootScope.$broadcast('installation', installation)
    return control.uploadUrl(url)
      .progressed(function(uploadResult) {
        installation.update(uploadResult.progress / 2, uploadResult.lastData)
      })
      .then(function(uploadResult) {
        installation.update(uploadResult.progress / 2, uploadResult.lastData)
        installation.manifest = uploadResult.body
        return control.install({
            href: installation.href,
            manifest: installation.manifest,
            launch: installation.launch
          })
          .progressed(function(result) {
            installation.update(50 + result.progress / 2, result.lastData)
          })
      })
      .then(function() {
        installation.okay('installed')
      })
      .catch(function(err) {
        installation.fail(err.code || err.message)
      })
  }

  installService.installFile = function(control, $files) {
    var installation = new Installation('uploading')
    var isIOSPlatform = AppState.device.platform === 'iOS'
    var originalFileName = $files[0] ? $files[0].name : 'unknown'
    var isApkFile = /\.(apk|aab)$/i.test(originalFileName)
    var isIpaFile = /\.(ipa)$/i.test(originalFileName)
    
    $rootScope.$broadcast('installation', installation)
    
    // Accept APK/AAB for Android, IPA for iOS, or any file for push
    return StorageService.storeFile('apk', $files, {
        filter: function(file) {
          // Allow all files - APK/AAB/IPA will be installed, others will be pushed
          return true
        }
    })
      .progressed(function(e) {
        if (e.lengthComputable) {
          installation.update(e.loaded / e.total * 100 / 2, 'uploading')
        }
      })
      .then(function(res) {
        installation.update(100 / 2, 'processing')
        installation.href = res.data.resources.file.href
        
        if (isIOSPlatform && isIpaFile) {
          // iOS IPA installation
          installation.manifest = {'application': {'activities': {}}}
          return control.install({
            href: installation.href,
            manifest: installation.manifest,
            launch: installation.launch
          })
            .progressed(function(result) {
              installation.update(50 + result.progress / 2, result.lastData)
            })
        } else if (isApkFile) {
          // Android APK/AAB installation
          return $http.get(installation.href + '/manifest')
            .then(function(res) {
              if (res.data.success) {
                installation.manifest = res.data.manifest
              } else {
                console.warn('Unable to retrieve manifest, using default manifest')
                installation.manifest = {
                  package: 'unknown',
                  application: { launcherActivities: [] }
                }
              }
              // Add originalFileName so backend knows file type
              installation.manifest.originalFileName = originalFileName
              return control.install({
                href: installation.href,
                manifest: installation.manifest,
                launch: installation.launch
              })
                .progressed(function(result) {
                  installation.update(50 + result.progress / 2, result.lastData)
                })
            })
        } else {
          // Non-APK file: push to /data/local/tmp
          installation.manifest = {
            package: originalFileName,
            application: { launcherActivities: [] },
            isPushOnly: true,
            originalFileName: originalFileName
          }
          return control.install({
            href: installation.href,
            manifest: installation.manifest,
            launch: false
          })
            .progressed(function(result) {
              installation.update(50 + result.progress / 2, result.lastData)
            })
        }
      })
      .then(function() {
        installation.okay(isApkFile || isIpaFile ? 'installed' : 'pushed')
      })
      .catch(function(err) {
        installation.fail(err.code || err.message)
      })
    }

  return installService
}
