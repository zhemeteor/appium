"use strict";

var setup = require("../../../common/setup-base"),
    desired = require('../desired'),
    _ = require('underscore');

describe('testapp - default autoDismissAlerts cap', function () {
  var self = this;
  var driver;

  var caps = _.clone(desired);
  setup(self, caps).then(function (d) { driver = d; });

  it('does not auto-dismiss alerts', function (done) {
    driver
      .elementByAccessibilityId('show alert').click()
      .sleep(2000)
      .alertText()
      .should.eventually.exist
      .nodeify(done);
  });
});

