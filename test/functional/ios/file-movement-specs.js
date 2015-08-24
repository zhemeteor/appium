"use strict";

var setup = require("../common/setup-base")
  , env = require('../../helpers/env')
  , getAppPath = require('sample-apps')
  , Readable = require('stream').Readable
  , Unzip = require('unzip');

describe('file movements - pullFile and pushFile @skip-real-device', function () {
  var driver;
  var desired = {
    app: getAppPath('TestApp', env.REAL_DEVICE)
  };
  setup(this, desired).then(function (d) { driver = d; });

  it('should not be able to fetch a file from the file system at large', function (done) {
    driver
      .pullFile(__filename)
      .should.be.rejected
    .nodeify(done);
  });

  it('should be able to fetch the Address book', function (done) {
    driver
      .pullFile('Library/AddressBook/AddressBook.sqlitedb')
      .then(function (data) {
        var stringData = new Buffer(data, 'base64').toString();
        return stringData.indexOf('SQLite').should.not.equal(-1);
      })
    .nodeify(done);
  });

  it('should not be able to fetch something that does not exist', function (done) {
    driver
      .pullFile('Library/AddressBook/nothere.txt')
      .should.eventually.be.rejectedWith(/13/)
    .nodeify(done);
  });

  it('should be able to push and pull a file', function (done) {
    var stringData = "random string data " + Math.random();
    var base64Data = new Buffer(stringData).toString('base64');
    var remotePath = 'Library/AppiumTest/remote.txt';

    driver
      .pushFile(remotePath, base64Data)
      .pullFile(remotePath)
      .then(function (remoteData64) {
        var remoteData = new Buffer(remoteData64, 'base64').toString();
        remoteData.should.equal(stringData);
      })
      .nodeify(done);
  });

  describe('for a .app @skip-ci', function () {
    // TODO: skipping ci because of local files use, to review.
    var appName = 'TestApp-iphonesimulator.app';

    it('should be able to fetch a file from the app directory', function (done) {
      driver
        .pullFile('/' + appName + '/en.lproj/Localizable.strings')
        .then(function (data) {
          var stringData = new Buffer(data, 'base64').toString();
          return stringData.should.include('computeSum');
        })
        .nodeify(done);
    });
  });

  describe('file movements - pullFolder', function () {
    it('should pull all the files in Library/AddressBook', function (done) {
      var entryCount = 0;
      driver
        .pullFolder('Library/AddressBook')
        .then(function (data) {
          var zipStream = new Readable();
          zipStream._read = function noop() {};
          zipStream
            .pipe(Unzip.Parse())
            .on('entry', function (entry) {
              entryCount++;
              entry.autodrain();
            })
            .on('close', function () {
              entryCount.should.be.above(1);
              done();
            });

          zipStream.push(data, 'base64');
          zipStream.push(null);
        });
    });

    it('should not pull folders from file system', function (done) {
      driver
        .pullFolder(__dirname)
          .should.be.rejected
        .nodeify(done);
    });

    it('should not be able to fetch a folder that does not exist', function (done) {
      driver
        .pullFolder('Library/Rollodex')
          .should.eventually.be.rejectedWith(/13/)
        .nodeify(done);
    });
  });
});
