var fs = require('fs')
var ApkReader = require('@devicefarmer/adbkit-apkreader')

module.exports = function(file) {
  // Simply read the APK manifest
  return ApkReader.open(file.path)
    .then(function(reader) {
      return reader.readManifest()
    })
}
