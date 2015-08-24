"use strict";

var setup = require("../common/setup-base")
  , _ = require("underscore")
  , path = require('path');
//  , getAppPath = require('../../helpers/app').getAppPath;

var appPath = path.resolve(__dirname, '../../..', 'sample-code/apps/TestApp/build/release-iphonesimulator/TestApp.app');
describe('crash recovery @skip-real-device', function () {
  var driver;
  var desired = {
    app: appPath
  };

  setup(this, desired, {}, {FAST_TESTS: false}).then(function (d) { driver = d; });

  it('should be able to recover gracefully from an app crash after shutdown', function (done) {
    driver
      .elementByAccessibilityId("Crash")
      .click()
      .then(function () {
        return driver.sleep(5000);
      })
      .source() // will 404 because the session is gone
        .should.eventually.be.rejectedWith('6')
    .nodeify(done);
  });
});

describe('crash commands @skip-real-device', function () {

  var driver;
  var desired = {
    app: appPath
  };

  setup(this, desired, {}, {FAST_TESTS: false}).then(function (d) { driver = d; });

  it('should not process new commands until after crash shutdown', function (done) {
    driver
      .execute("$.crash()") // this causes instruments to shutdown during
                            // this command
        .should.eventually.be.rejectedWith('13')
      .status()
      .then(function (s) {
        if (_.has(s, 'isShuttingDown')) {
          s.isShuttingDown.should.eql(false);
        }
      })
    .nodeify(done);
  });
});
