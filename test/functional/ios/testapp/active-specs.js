"use strict";

var setup = require("../../common/setup-base"),
    desired = require('./desired');

// TODO: this test does not work
describe.skip('testapp - active', function () {
  var driver;
  setup(this, desired).then(function (d) { driver = d; });

  it('should return active element', function (done) {
    var elem;
    return driver
      .elementsByClassName('UIATextField').then(function (elems) {
        elem = elems[1];
      }).then(function () {
        return driver
          .active();
          //.equals(elem).should.be.ok;
      }).then(function(activeEl) {
        activeEl.should.deep.equal(elem);
      }).nodeify(done);
  });
});
