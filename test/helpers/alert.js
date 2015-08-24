"use strict";

exports.okIfAlert = function (driver) {
  return driver
    .alertText()
    .then(function (text) {
      if (text) {
        return driver.acceptAlert();
      }
    });
    // TODO: this catch looks wrong commenting
    //.catch(function () {});
};
