var _ = require('lodash')

module.exports = function DeviceControlCtrl($scope, DeviceService, GroupService,
  $location, $timeout, $window, $rootScope, LogcatService) {

  $scope.showScreen = true

  // Device control header collapse state - default to false (not collapsed)
  $scope.deviceHeaderCollapsed = false
  
  $scope.toggleDeviceHeader = function() {
    $scope.deviceHeaderCollapsed = !$scope.deviceHeaderCollapsed
    localStorage.setItem('deviceHeaderCollapsed', $scope.deviceHeaderCollapsed)
  }

  // Fullscreen mode - collapse both headers
  $scope.toggleFullscreen = function() {
    // Collapse both headers
    $scope.deviceHeaderCollapsed = true
    localStorage.setItem('deviceHeaderCollapsed', 'true')
    
    // Also collapse main header by broadcasting event to parent scope
    $rootScope.$broadcast('collapseMainHeader')
  }

  $scope.groupTracker = DeviceService.trackGroup($scope)

  $scope.groupDevices = $scope.groupTracker.devices

  $scope.$on('$locationChangeStart', function(event, next, current) {
    $scope.LogcatService = LogcatService
    $rootScope.LogcatService = LogcatService
  })

  $scope.kickDevice = function(device) {
    if (Object.keys(LogcatService.deviceEntries).includes(device.serial)) {
      LogcatService.deviceEntries[device.serial].allowClean = true
    }

    $scope.LogcatService = LogcatService
    $rootScope.LogcatService = LogcatService

    if (!device || !$scope.device) {
      alert('No device found')
      return
    }

    try {
      // If we're trying to kick current device
      if (device.serial === $scope.device.serial) {

        // If there is more than one device left
        if ($scope.groupDevices.length > 1) {

          // Control first free device first
          var firstFreeDevice = _.find($scope.groupDevices, function(dev) {
            return dev.serial !== $scope.device.serial
          })
          $scope.controlDevice(firstFreeDevice)

          // Then kick the old device
          GroupService.kick(device).then(function() {
            $scope.$digest()
          })
        } else {
          // Kick the device
          GroupService.kick(device).then(function() {
            $scope.$digest()
          })
          $location.path('/devices/')
        }
      } else {
        GroupService.kick(device).then(function() {
          $scope.$digest()
        })
      }
    } catch (e) {
      alert(e.message)
    }
  }

  $scope.controlDevice = function(device) {
    $location.path('/control/' + device.serial)
  }

  function isPortrait(val) {
    var value = val
    if (typeof value === 'undefined' && $scope.device) {
      value = $scope.device.display.rotation
    }
    return (value === 0 || value === 180)
  }

  function isLandscape(val) {
    var value = val
    if (typeof value === 'undefined' && $scope.device) {
      value = $scope.device.display.rotation
    }
    return (value === 90 || value === 270)
  }

  $scope.tryToRotate = function(rotation) {
    if (rotation === 'portrait') {
      $scope.control.rotate(0)
      $timeout(function() {
        if (isLandscape()) {
          $scope.currentRotation = 'landscape'
        }
      }, 400)
    } else if (rotation === 'landscape') {
      $scope.control.rotate(90)
      $timeout(function() {
        if (isPortrait()) {
          $scope.currentRotation = 'portrait'
        }
      }, 400)
    }
  }

  $scope.currentRotation = 'portrait'

  // Screen rotation lock state
  // accelerometer_rotation: 1 = auto-rotate enabled (unlocked), 0 = locked
  $scope.rotationLocked = false

  // Get initial rotation lock state
  function getRotationLockState() {
    if ($scope.control && $scope.control.shell) {
      $scope.control.shell('settings get system accelerometer_rotation')
        .then(function(result) {
          // Result is '1' for auto-rotate enabled (unlocked), '0' for locked
          var value = (result.output || '').trim()
          $scope.rotationLocked = (value === '0')
          $scope.$apply()
        })
        .catch(function(err) {
          console.error('Failed to get rotation lock state:', err)
        })
    }
  }

  // Toggle rotation lock
  $scope.toggleRotationLock = function() {
    if ($scope.control && $scope.control.shell) {
      var newValue = $scope.rotationLocked ? '1' : '0'
      $scope.control.shell('settings put system accelerometer_rotation ' + newValue)
        .then(function() {
          $scope.rotationLocked = !$scope.rotationLocked
          $scope.$apply()
        })
        .catch(function(err) {
          console.error('Failed to toggle rotation lock:', err)
        })
    }
  }

  // Get rotation lock state when control is available
  $scope.$watch('control', function(newControl) {
    if (newControl && newControl.shell) {
      $timeout(function() {
        getRotationLockState()
      }, 500)
    }
  })

  $scope.$watch('device.display.rotation', function(newValue) {
    if (isPortrait(newValue)) {
      $scope.currentRotation = 'portrait'
    } else if (isLandscape(newValue)) {
      $scope.currentRotation = 'landscape'
    }
  })

  // TODO: Refactor this inside control and server-side
  $scope.rotateLeft = function() {
    var angle = 0
    if ($scope.device && $scope.device.display) {
      angle = $scope.device.display.rotation
    }
    if (angle === 0) {
      angle = 270
    } else {
      angle -= 90
    }
    $scope.control.rotate(angle)

    if ($rootScope.standalone) {
      $window.resizeTo($window.outerHeight, $window.outerWidth)
    }
  }

  $scope.rotateRight = function() {
    var angle = 0
    if ($scope.device && $scope.device.display) {
      angle = $scope.device.display.rotation
    }
    if (angle === 270) {
      angle = 0
    } else {
      angle += 90
    }
    $scope.control.rotate(angle)

    if ($rootScope.standalone) {
      $window.resizeTo($window.outerHeight, $window.outerWidth)
    }
  }

}
