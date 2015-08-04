"use strict";
import path from 'path';
import { ncp as _ncp } from 'ncp';
import fs from 'fs';
import _ from 'underscore';
import _which from 'which';
import logger from './logger';
import { exec, spawn } from 'child_process';
import Device from '../device.js';
import Instruments from './instruments.js';
import { xcode } from '../../future.js';
import { UnknownError } from '../../server/errors.js';
import deviceCommon from '../common.js';
import iOSLog from './ios-log.js';
import iOSCrashLog from './ios-crash-log.js';
import status from '../../server/status.js';
import iDevice from 'node-idevice';
import asynclib from 'async';
import iOSController from './ios-controller.js';
import iOSHybrid from './ios-hybrid.js';
import settings from './settings.js';
import Simulator from './simulator.js';
import { prepareBootstrap, CommandProxy } from './uiauto';
import { Constructor as Args } from 'vargs';
import { logCustomDeprecationWarning } from '../../helpers';

import B from 'bluebird';
import { parsePlistFile, updatePlistFile } from 'appium-ios-driver/build/lib/plist-utils';
import { removeInstrumentsSocket } from 'appium-ios-driver/build/lib/utils';

let ncp = B.promisify(_ncp);
let which = B.promisify(_which);

// TODO: use appium-support
let _fs = {
  access: B.promisify(fs.access),
  hasAccess: async function (path) {
    try {
      await this.access(path, fs.F_OK | fs.R_OK);
    } catch (err) {
      return false;
    }
    return true;
  },
  exists: async function (path) { return await this.hasAccess(path); },
};

class IOS extends Device {
  constructor() {
    super();
    this.init();
  }

  init () {
    super.init();
    this.appExt = ".app";
    this.capabilities = {
      webStorageEnabled: false
    , locationContextEnabled: false
    , browserName: 'iOS'
    , platform: 'MAC'
    , javascriptEnabled: true
    , databaseEnabled: false
    , takesScreenshot: true
    , networkConnectionEnabled: false
    };
    this.xcodeVersion = null;
    this.iOSSDKVersion = null;
    this.iosSimProcess = null;
    this.iOSSimUdid = null;
    this.logs = {};
    this.instruments = null;
    this.commandProxy = null;
    this.initQueue();
    this.onInstrumentsDie = function () {};
    this.stopping = false;
    this.cbForCurrentCmd = null;
    this.remote = null;
    this.curContext = null;
    this.curWebFrames = [];
    this.selectingNewPage = false;
    this.processingRemoteCmd = false;
    this.remoteAppKey = null;
    this.windowHandleCache = [];
    this.webElementIds = [];
    this.implicitWaitMs = 0;
    this.asynclibWaitMs = 0;
    this.pageLoadMs = 60000;
    this.asynclibResponseCb = null;
    this.returnedFromExecuteAtom = {};
    this.executedAtomsCounter = 0;
    this.curCoords = null;
    this.curWebCoords = null;
    this.onPageChangeCb = null;
    this.supportedStrategies = ["name", "xpath", "id", "-ios uiautomation",
                                "class name", "accessibility id"];
    this.landscapeWebCoordsOffset = 0;
    this.localizableStrings = {};
    this.keepAppToRetainPrefs = false;
    this.isShuttingDown = false;
  }

  async _configure (args, caps) {
    let msg;
    super.configure(args, caps);
    this.setIOSArgs();

    if (this.args.locationServicesAuthorized && !this.args.bundleId) {
      msg = "You must set the bundleId cap if using locationServicesEnabled";
      logger.error(msg);
      throw new Error(msg);
    }

    // on iOS8 we can use a bundleId to launch an app on the simulator, but
    // on previous versions we can only do so on a real device, so we need
    // to do a check of which situation we're in
    let ios8 = caps.platformVersion &&
               parseFloat(caps.platformVersion) >= 8;

    if (!this.args.app &&
        !((ios8 || this.args.udid) && this.args.bundleId)) {
      msg = "Please provide the 'app' or 'browserName' capability or start " +
            "appium with the --app or --browser-name argument. Alternatively, " +
            "you may provide the 'bundleId' and 'udid' capabilities for an app " +
            "under test on a real device.";
      logger.error(msg);

      throw new Error(msg);
    }

    if (parseFloat(caps.platformVersion) < 7.1) {
      logCustomDeprecationWarning('iOS version', caps.platformVersion,
                                  'iOS ' + caps.platformVersion + ' support has ' +
                                  'been deprecated and will be removed in a ' +
                                  'future version of Appium.');
    }

    return await this._configureApp();
  }

  configure (args, caps, cb) {
    B.resolve(this._configure(args, caps)).nodeify(cb);
  }

  setIOSArgs () {
    this.args.withoutDelay = !this.args.nativeInstrumentsLib;
    this.args.reset = !this.args.noReset;
    this.args.initialOrientation = this.capabilities.deviceOrientation ||
                                   this.args.orientation ||
                                   "PORTRAIT";
    this.useRobot = this.args.robotPort > 0;
    this.args.robotUrl = this.useRobot ?
      "http://" + this.args.robotAddress + ":" + this.args.robotPort + "" :
      null;
    this.curOrientation = this.args.initialOrientation;
    this.sock = path.resolve(this.args.tmpDir || '/tmp', 'instruments_sock');

    this.perfLogEnabled = !!(typeof this.args.loggingPrefs === 'object' && this.args.loggingPrefs.performance);
  }

  async _configureApp () {
    try {
      let app = this.appString();

      // if the app name is a bundleId assign it to the bundleId property
      if (!this.args.bundleId && this.appIsPackageOrBundle(app)) {
        this.args.bundleId = app;
      }

      if (app !== "" && app.toLowerCase() === "settings") {
        if (parseFloat(this.args.platformVersion) >= 8) {
          logger.debug("We're on iOS8+ so not copying preferences app");
          this.args.bundleId = "com.apple.Preferences";
          this.args.app = null;
        }
        return;
      } else if (this.args.bundleId &&
                 this.appIsPackageOrBundle(this.args.bundleId) &&
                 (app === "" || this.appIsPackageOrBundle(app))) {
        // we have a bundle ID, but no app, or app is also a bundle
        logger.debug("App is an iOS bundle, will attempt to run as pre-existing");
        return;
      } else {
        await B.fromNode(Device.prototype.configureApp.bind(this));
      }
    } catch (err) {
      throw new Error("Bad app: " + this.args.app + ". App paths need to " +
                      "be absolute, or relative to the appium server " +
                      "install dir, or a URL to compressed file, or a " +
                      "special app name. cause: " + err);
     }
  }

  configureApp (cb) {
    B.resolve(this._configureApp()).nodeify(cb);
  }

  getNumericVersion () {
    return parseFloat(this.args.platformVersion);
  }

  async startRealDevice () {
    await removeInstrumentsSocket(this.sock);
    await this.detectUdid();
    await this._parseLocalizableStrings();
    await this.setBundleIdFromApp();
    await this.createInstruments();
    await B.fromNode(this.startLogCapture.bind(this));
    await this._installToRealDevice();
    await B.fromNode(this.startInstruments.bind(this));
    await this.onInstrumentsLaunch();
    await this.configureBootstrap();
    await this._setBundleId();
    await this._setInitialOrientation();
    await B.fromNode(this.initAutoWebview.bind(this));
    await this.waitForAppLaunched();
  }

  async startSimulator () {
    await removeInstrumentsSocket(this.sock);
    await this.setXcodeVersion();
    await this.setiOSSDKVersion();
    await this.checkSimAvailable();
    await this.createSimulator();
    await this._moveBuiltInApp();
    await this.detectUdid();
    await this._parseLocalizableStrings();
    await this.setBundleIdFromApp();
    await this.createInstruments();
    await this.setDeviceInfo();
    await this.checkPreferences();
    await this.runSimReset();
    await this.isolateSimDevice();
    await this.setLocale();
    await this.setPreferences.bind();
    await B.fromNode(this.startLogCapture.bind(this));
    await this.prelaunchSimulator();
    await B.fromNode(this.startInstruments.bind(this));
    await this.onInstrumentsLaunch();
    await this.configureBootstrap();
    await this._setBundleId();
    await this._setInitialOrientation();
    await B.fromNode(this.initAutoWebview.bind(this));
    await this.waitForAppLaunched();
  }

  async _start (onDie) {
    if (this.instruments !== null) {
      let msg = "Trying to start a session but instruments is still around";
      logger.error(msg);
      throw new Error(msg);
    }

    if (typeof onDie === "function") {
      this.onInstrumentsDie = onDie;
    }

    if (this.args.udid) {
      await this.startRealDevice();
    } else {
      await this.startSimulator();
    }
  }

  start (cb, onDie) {
    B.resolve(this._start(onDie)).nodeify(cb);
  }

  async createInstruments () {
    logger.debug("Creating instruments");
    this.commandProxy = new CommandProxy({ sock: this.sock });
    this.instruments = await this.makeInstruments();
  }

  startInstruments (cb) {
    // TODO: appium-uiauto + command proxy need to be plug in there
    cb = _.once(cb);

    let treatError = function (err, cb) {
      if (!_.isEmpty(this.logs)) {
        this.logs.syslog.stopCapture();
        this.logs = {};
      }
      B.resolve(this.postCleanup()).nodeify(function () {
        cb(err);
      });
    }.bind(this);

    logger.debug("Starting command proxy.");
    this.commandProxy.start(
      function onFirstConnection(err) {
        // first let instruments know so that it does not restart itself
        this.instruments.launchHandler(err);
        // then we call the callback
        cb(err);
      }.bind(this)
    , function regularCallback(err) {
        if (err) return treatError(err, cb);
        logger.debug("Starting instruments");
        this.instruments.start(
          function (err) {
            if (err) return treatError(err, cb);
            // we don't call cb here, waiting for first connection or error
          }.bind(this)
        , function (code) {
            if (!this.shouldIgnoreInstrumentsExit()) {
              this.onUnexpectedInstrumentsExit(code);
            }
          }.bind(this)
        );
      }.bind(this)
    );
  }

  async makeInstruments () {

    // at the moment all the logging in uiauto is at debug level
    // TODO: be able to use info in appium-uiauto
    let bootstrapPath = await prepareBootstrap({
      sock: this.sock,
      interKeyDelay: this.args.interKeyDelay,
      justLoopInfinitely: false,
      autoAcceptAlerts: !(!this.args.autoAcceptAlerts || this.args.autoAcceptAlerts === 'false'),
      autoDismissAlerts: !(!this.args.autoDismissAlerts || this.args.autoDismissAlerts === 'false'),
      sendKeyStrategy: this.args.sendKeyStrategy || (this.args.udid ? 'grouped' : 'oneByOne')
    });

    return new Instruments({
      // on real devices bundleId is always used
      app: (!this.args.udid ? this.args.app : null) || this.args.bundleId
    , udid: this.args.udid
    , processArguments: this.args.processArguments
    , ignoreStartupExit: this.shouldIgnoreInstrumentsExit()
    , bootstrap: bootstrapPath
    , template: this.args.automationTraceTemplatePath
    , instrumentsPath: this.args.instrumentsPath
    , withoutDelay: this.args.withoutDelay
    , platformVersion: this.args.platformVersion
    , webSocket: this.args.webSocket
    , launchTimeout: this.args.launchTimeout
    , flakeyRetries: this.args.backendRetries
    , simulatorSdkAndDevice: this.iOSSDKVersion >= 7.1 ? this.getDeviceString() : null
    , tmpDir: path.resolve(this.args.tmpDir , 'appium-instruments')
    , traceDir: this.args.traceDir
    });
  }

  shouldIgnoreInstrumentsExit () {
    return false;
  }

  async onInstrumentsLaunch () {
    logger.debug('Instruments launched. Starting poll loop for new commands.');
    this.instruments.setDebug(true);
    if (this.args.origAppPath) {
      logger.debug("Copying app back to its original place");
      return await ncp.bind(this.args.app, this.args.origAppPath);
    }
  }

  async _setBundleId () {
    if (this.args.bundleId) {
      // We already have a bundle Id
      return;
    } else {
      let bId = await B.fromNode(this.proxy.bind(this, 'au.bundleId()'));
      logger.debug('Bundle ID for open app is ' + bId.value);
      this.args.bundleId = bId.value;
    }
  }

  setBundleId (cb) {
    B.resolve(this._setBundleId()).nodeify(cb);
  }

  async _setInitialOrientation () {
    if (typeof this.args.initialOrientation === "string" &&
        _.contains(["LANDSCAPE", "PORTRAIT"],
                   this.args.initialOrientation.toUpperCase())
        ) {
      logger.debug("Setting initial orientation to " + this.args.initialOrientation);
      let command = ["au.setScreenOrientation('",
        this.args.initialOrientation.toUpperCase(), "')"].join('');
      try {
        let res = await B.fromNode(this.proxy.bind(this, command));
        if (res.status === status.codes.Success.code) {
          this.curOrientation = this.args.initialOrientation;
        } else {
          logger.warn("Setting initial orientation did not work!");
        }
      } catch (err) {
        logger.warn("Setting initial orientation failed with:", err);
      }
    }
  }

  setInitialOrientation (cb) {
    B.resolve(this._setInitialOrientation()).nodeify(cb);
  }

  static isSpringBoard (uiAppObj) {
  // Test for iOS homescreen (SpringBoard). AUT occassionally start the sim, but fails to load
  // the app. If that occurs, getSourceForElementFoXML will return a doc object that meets our
  // app-check conditions, resulting in a false positive. This function tests the UiApplication
  // property's meta data to ensure that the Appium doesn't confuse SpringBoard with the app
  // under test.
    return _.propertyOf(uiAppObj['@'])('name') === 'SpringBoard';
  }

  async waitForAppLaunched  () {
    // on iOS8 in particular, we can get a working session before the app
    // is ready to respond to commands; in that case the source will be empty
    // so we just spin until it's not
    let condFn;
    if (this.args.waitForAppScript) {
      // the default getSourceForElementForXML does not fit some use case, so making this customizable.
      // TODO: collect script from customer and propose several options, please comment in issue #4190.
      logger.debug("Using custom script to wait for app start:" + this.args.waitForAppScript);
      condFn = async () => {
        let res = await B.fromNode(this.proxy.bind(this, 'try{\n' + this.args.waitForAppScript +
                   '\n} catch(err) { $.log("waitForAppScript err: " + error); false; };'));
        if(!res.value) {
          throw new Error('Not started yet!');
        }
      };
    } else {
      logger.debug("Waiting for app source to contain elements");
      condFn = async () => {
        let res = await B.fromNode(this.getSourceForElementForXML.bind(this ,null));
        if (!res || res.status !== status.codes.Success.code) {
          throw new Error('No elements yet!');
        }
        let sourceObj, appEls;
        try {
          sourceObj = JSON.parse(res.value);
          appEls = sourceObj.UIAApplication['>'];

          if (appEls.length > 0 && !IOS.isSpringBoard(sourceObj.UIAApplication)) {
            return;
          } else {
            throw new Error("App did not have elements");
          }
        } catch (e) {
          throw new Error("Couldn't parse JSON source");
        }
        return;
      };
    }
    // TODO: move to asyncbox
    let fixedWaitForCondition = (limitMs, condFn, cb, poolMs) => {
      this.waitForCondition(limitMs, condFn, poolMs, cb);
    };
    return await B.fromNode(fixedWaitForCondition.bind(
      null, 10000, (cb) => { condFn().nodeify(cb); } , 500));
  }

  async configureBootstrap () {
    logger.debug("Setting bootstrap config keys/values");
    let isVerbose = logger.transports.console.level === 'debug';
    let cmd = '';
    cmd += 'target = $.target();\n';
    cmd += 'au = $;\n';
    cmd += '$.isVerbose = ' + isVerbose + ';\n';
    // Not using uiauto grace period because of bug.
    // cmd += '$.target().setTimeout(1);\n';
    await B.fromNode(this.proxy.bind(this, cmd));
  }

  onUnexpectedInstrumentsExit  (code) {
    // TODO: see how this works with es6
    logger.debug("Instruments exited unexpectedly");
    this.isShuttingDown = true;
    let postShutdown = function () {
      if (typeof this.cbForCurrentCmd === "function") {
        logger.debug("We were in the middle of processing a command when " +
                     "instruments died; responding with a generic error");
        let error = new UnknownError("Instruments died while responding to " +
                                     "command, please check appium logs");
        this.onInstrumentsDie(error, this.cbForCurrentCmd);
      } else {
        this.onInstrumentsDie();
      }
    }.bind(this);
    if (this.commandProxy) {
      this.commandProxy.safeShutdown(function () {
        B.resolve(this.shutdown(code)).nodeify(postShutdown);
      }.bind(this));
    } else {
      B.resolve(this.shutdown(code)).nodeify(postShutdown);
    }
  }

  async setXcodeVersion () {
    logger.debug("Setting Xcode version");
    let versionNumber;
    try {
      versionNumber = await xcode.getVersion();
    } catch (err) {
      logger.error("Could not determine Xcode version:" + err.message);
    }
    let minorVersion = parseFloat(versionNumber.slice(0, 3));
    let pv = parseFloat(this.args.platformVersion);
    // we deprecate Xcodes < 6.3, except for iOS 8.0 in which case we
    // support Xcode 6.0 as well
    if (minorVersion < 6.3 && (!(minorVersion === 6.0 && pv === 8.0))) {
      logCustomDeprecationWarning('Xcode version', versionNumber,
                                  'Support for Xcode ' + versionNumber + ' ' +
                                  'has been deprecated and will be removed ' +
                                  'in a future version. Please upgrade ' +
                                  'to version 6.3 or higher (or version ' +
                                  '6.0.1 for iOS 8.0)');
    }
    this.xcodeVersion = versionNumber;
    logger.debug("Xcode version set to " + versionNumber);
  }

  async setiOSSDKVersion () {
    logger.debug("Setting iOS SDK Version");
    let versionNumber;
    try {
      versionNumber = await xcode.getMaxIOSSDK();
    } catch (err) {
      logger.error("Could not determine iOS SDK version");
      throw err;
    }
    this.iOSSDKVersion = versionNumber;
    logger.debug("iOS SDK Version set to " + this.iOSSDKVersion);
  }

  async setLocale () {
    let msg;
    let setLoc = async () => {
      logger.debug("Setting locale information");
      let needSimRestart = false;
      this.localeConfig = this.localeConfig || {};
      _(['language', 'locale', 'calendarFormat']).each(function (key) {
        needSimRestart = needSimRestart ||
                        (this.args[key] &&
                         this.args[key] !== this.localeConfig[key]);
      }, this);
      this.localeConfig = {
        language: this.args.language,
        locale: this.args.locale,
        calendarFormat: this.args.calendarFormat
      };
      let simRoots = this.sim.getDirs();
      if (simRoots.length < 1) {
        msg = "Cannot set locale information because the iOS Simulator directory could not be determined.";
        logger.error(msg);
        throw new Error(msg);
      }

      try {
        this.sim.setLocale(this.args.language, this.args.locale, this.args.calendarFormat);
      } catch (e) {
        msg = "Appium was unable to set locale info: " + e;
        logger.error(msg);
        throw new Error(msg);
      }

      logger.debug("Locale was set");
      if (needSimRestart) {
        logger.debug("First time setting locale, or locale changed, killing existing Instruments and Sim procs.");
        Instruments.killAllSim();
        Instruments.killAll();
        await B.delay(250);
      }
    };

    if ((this.args.language || this.args.locale || this.args.calendarFormat) && this.args.udid === null) {

      if (this.args.fullReset && this.args.platformVersion <= 6.1) {
        msg = "Cannot set locale information because a full-reset was requested. full-reset interferes with the language/locale caps on iOS 6.1 and older";
        logger.error(msg);
        throw new Error(msg);
      }

      if (!this.sim.dirsExist()) {
        await this.instantLaunchAndQuit(false);
      }
      await setLoc();

    } else if (this.args.udid) {
      logger.debug("Not setting locale because we're using a real device");
    } else {
      logger.debug("Not setting locale");
    }
  }

  async checkPreferences () {
    logger.debug("Checking whether we need to set app preferences");
    if (this.args.udid !== null) {
      logger.debug("Not setting iOS and app preferences since we're on a real " +
                  "device");
      return;
    }

    let settingsCaps = [
      'locationServicesEnabled',
      'locationServicesAuthorized',
      'safariAllowPopups',
      'safariIgnoreFraudWarning',
      'safariOpenLinksInBackground'
    ];
    let safariSettingsCaps = settingsCaps.slice(2, 5);
    this.needToSetPrefs = false;
    this.needToSetSafariPrefs = false;
    _.each(settingsCaps, function (cap) {
      if (_.has(this.capabilities, cap)) {
        this.needToSetPrefs = true;
        if (_.contains(safariSettingsCaps, cap)) {
          this.needToSetSafariPrefs = true;
        }
      }
    }.bind(this));

    this.keepAppToRetainPrefs = this.needToSetPrefs;
  }

  async setPreferences () {
    if (!this.needToSetPrefs) {
      logger.debug("No iOS / app preferences to set");
      return;
    } else if (this.args.fullReset) {
      let msg = "Cannot set preferences because a full-reset was requested";
      logger.debug(msg);
      logger.error(msg);
      throw new Error(msg);
    }

    logger.debug("Setting iOS and app preferences");
    if (!this.sim.dirsExist() ||
        !settings.locServicesDirsExist(this.sim) ||
        (this.needToSetSafariPrefs && !this.sim.safariDirsExist())) {
      await this.instantLaunchAndQuit(this.needToSetSafariPrefs);
    }
    try {
      this.setLocServicesPrefs();
    } catch (e) {
      logger.error("Error setting location services preferences, prefs will not work");
      logger.error(e);
      logger.error(e.stack);
    }
    try {
      this.setSafariPrefs();
    } catch (e) {
      logger.error("Error setting safari preferences, prefs will not work");
      logger.error(e);
      logger.error(e.stack);
    }
  }

  async instantLaunchAndQuit (needSafariDirs) {
    logger.debug("Sim files for the " + this.iOSSDKVersion + " SDK do not yet exist, launching the sim " +
        "to populate the applications and preference dirs");

    let condition = function () {
      let simDirsExist = this.sim.dirsExist();
      let locServicesExist = settings.locServicesDirsExist(this.sim);
      let safariDirsExist = this.args.platformVersion < 7.0 ||
                            (this.sim.safariDirsExist() &&
                             (this.args.platformVersion < 8.0 ||
                              this.sim.userSettingsPlistExists())
                            );
      let okToGo = simDirsExist && locServicesExist &&
                   (!needSafariDirs || safariDirsExist);
      if (!okToGo) {
        logger.debug("We launched the simulator but the required dirs don't " +
                     "yet exist. Waiting some more...");
      }
      return okToGo;
    }.bind(this);

    await this.prelaunchSimulator();
    let instruments = await this.makeInstruments();
    await B.fromNode(instruments.launchAndKill.bind(this, condition));
    await this.endSimulator();
  }

  setLocServicesPrefs () {
    if (typeof this.capabilities.locationServicesEnabled !== "undefined" ||
        this.capabilities.locationServicesAuthorized) {
      let locServ = this.capabilities.locationServicesEnabled;
      locServ = locServ || this.capabilities.locationServicesAuthorized;
      locServ = locServ ? 1 : 0;
      logger.debug("Setting location services to " + locServ);
      settings.updateSettings(this.sim, 'locationServices', {
           LocationServicesEnabled: locServ,
          'LocationServicesEnabledIn7.0': locServ,
          'LocationServicesEnabledIn8.0': locServ
         }
      );
    }
    if (typeof this.capabilities.locationServicesAuthorized !== "undefined") {
      if (!this.args.bundleId) {
        let msg = "Can't set location services for app without bundle ID";
        logger.error(msg);
        throw new Error(msg);
      }
      let locAuth = !!this.capabilities.locationServicesAuthorized;
      if (locAuth) {
        logger.debug("Authorizing location services for app");
      } else {
        logger.debug("De-authorizing location services for app");
      }
      settings.updateLocationSettings(this.sim, this.args.bundleId, locAuth);
    }
  }


  setSafariPrefs () {
    let safariSettings = {};
    let val;
    if (_.has(this.capabilities, 'safariAllowPopups')) {
      val = !!this.capabilities.safariAllowPopups;
      logger.debug("Setting javascript window opening to " + val);
      safariSettings.WebKitJavaScriptCanOpenWindowsAutomatically = val;
      safariSettings.JavaScriptCanOpenWindowsAutomatically = val;
    }
    if (_.has(this.capabilities, 'safariIgnoreFraudWarning')) {
      val = !this.capabilities.safariIgnoreFraudWarning;
      logger.debug("Setting fraudulent website warning to " + val);
      safariSettings.WarnAboutFraudulentWebsites = val;
    }
    if (_.has(this.capabilities, 'safariOpenLinksInBackground')) {
      val = this.capabilities.safariOpenLinksInBackground ? 1 : 0;
      logger.debug("Setting opening links in background to " + !!val);
      safariSettings.OpenLinksInBackground = val;
    }
    if (_.size(safariSettings) > 0) {
      settings.updateSafariSettings(this.sim, safariSettings);
    }
  }

  async detectUdid () {
    let msg;
    logger.debug("Auto-detecting iOS udid...");
    if (this.args.udid !== null && this.args.udid === "auto") {
      let udidetectPath;
      try {
        let cmdPath = await which('idevice_id');
        udidetectPath = cmdPath + " -l";
      } catch (err) {
        udidetectPath = require.resolve('udidetect');
      }
      let stdout;
      try {
        [stdout] = await B.fromNode(exec.bind(this, udidetectPath, { maxBuffer: 524288, timeout: 3000 }));
      } catch (err) {
        msg = "Error detecting udid: " + err.message;
        logger.error(msg);
        throw err;
      }
      if (stdout && stdout.length > 2) {
        this.args.udid = stdout.split("\n")[0];
        logger.debug("Detected udid as " + this.args.udid);
       } else {
         let msg = "Could not detect udid.";
         logger.error(msg);
         throw new Error(msg);
      }
    } else {
      logger.debug("Not auto-detecting udid, running on sim");
    }
  }

  async setBundleIdFromApp () {
    // This method will try to extract the bundleId from the app
    if (!this.args.bundleId) {
      try {
        this.args.bundleId = await this.getBundleIdFromApp();
      } catch (err) {
        logger.error("Could not set the bundleId from app.");
        throw err;
      }
    }
  }

  async _installToRealDevice () {
    // get a real device object to deal with incoming queries
    this.realDevice = this.getIDeviceObj();

    // if user has passed in desiredCaps.autoLaunch = false
    // meaning they will manage app install / launching
    if (this.args.autoLaunch === false) {
      return;
    } else {
      if (this.args.udid) {
        let installed;
        try {
          installed = await B.fromNode(this.isAppInstalled.bind(this, this.args.bundleId));
        } catch (err) {
          installed = false;
        }
        if (!installed) {
          logger.debug("App is not installed. Will try to install the app.");
        } else {
          logger.debug("App is installed.");
          if (this.args.fullReset) {
            logger.debug("fullReset requested. Forcing app install.");
          } else {
            logger.debug("fullReset not requested. No need to install.");
            return;
          }
          if (this.args.ipa && this.args.bundleId) {
            await this.installIpa();
          } else if (this.args.ipa) {
            let msg = "You specified a UDID and ipa but did not include the bundle " +
              "id";
            logger.error(msg);
            throw new Error(msg);
          } else if (this.args.app) {
            await B.fromNode(this.installApp.bind(this, this.args.app));
          } else {
            logger.debug("Real device specified but no ipa or app path, assuming bundle ID is " +
                         "on device");
          }
        }
      } else {
        logger.debug("No device id or app, not installing to real device.");
      }
    }
  }

  installToRealDevice (cb) {
    B.resolve(this._installToRealDevice()).nodeify(cb);
  }

  getIDeviceObj () {
    let idiPath = path.resolve(__dirname, "../../../build/",
                               "libimobiledevice-macosx/ideviceinstaller");
    logger.debug("Creating iDevice object with udid " + this.args.udid);
    try {
      return iDevice(this.args.udid);
    } catch (e1) {
      logger.debug("Couldn't find ideviceinstaller, trying built-in at " +
                  idiPath);
      try {
        return iDevice(this.args.udid, {cmd: idiPath});
      } catch (e2) {
        let msg = "Could not initialize ideviceinstaller; make sure it is " +
                  "installed and works on your system";
        logger.error(msg);
        throw new Error(msg);
      }
    }
  }

  async installIpa () {
    logger.debug("Installing ipa found at " + this.args.ipa);
    if (!this.realDevice) {
      this.realDevice = this.getIDeviceObj();
    }
    let d = this.realDevice;
    let installed = B.fromNode(d.isInstalled.bind(d,this.args.bundleId));
    if (installed) {
      logger.debug("Bundle found on device, removing before reinstalling.");
      await B.fromNode(d.remove.bind(d, this.args.bundleId));
    } else {
      logger.debug("Nothing found on device, going ahead and installing.");
    }
    await B.fromNode(d.installAndWait.bind(d, this.args.ipa, this.args.bundleId));
  }

  static getDeviceStringFromOpts (opts) {
    logger.debug("Getting device string from opts: " + JSON.stringify({
      forceIphone: opts.forceIphone,
      forceIpad: opts.forceIpad,
      xcodeVersion: opts.xcodeVersion,
      iOSSDKVersion: opts.iOSSDKVersion,
      deviceName: opts.deviceName,
      platformVersion: opts.platformVersion
    }));
    let isiPhone = opts.forceIphone || opts.forceIpad === null || (opts.forceIpad !== null && !opts.forceIpad);
    let isTall = isiPhone;
    let isRetina = opts.xcodeVersion[0] !== '4';
    let is64bit = false;
    let deviceName = opts.deviceName;
    let fixDevice = true;
    if (deviceName && deviceName[0] === '=') {
      return deviceName.substring(1);
    }
    logger.debug("fixDevice is " + (fixDevice ? "on" : "off"));
    if (deviceName) {
      let device = deviceName.toLowerCase();
      if (device.indexOf("iphone") !== -1) {
        isiPhone = true;
      } else if (device.indexOf("ipad") !== -1) {
        isiPhone = false;
      }
      if (deviceName !== opts.platformName) {
        isTall = isiPhone && (device.indexOf("4-inch") !== -1);
        isRetina =  (device.indexOf("retina") !== -1);
        is64bit = (device.indexOf("64-bit") !== -1);
      }
    }

    let iosDeviceString = isiPhone ? "iPhone" : "iPad";
    if (opts.xcodeVersion[0] === '4') {
      if (isiPhone && isRetina) {
        iosDeviceString += isTall ? " (Retina 4-inch)" : " (Retina 3.5-inch)";
      } else {
        iosDeviceString += isRetina ? " (Retina)" : "";
      }
    } else if (opts.xcodeVersion[0] === '5') {
      iosDeviceString += isRetina ? " Retina" : "";
      if (isiPhone) {
        if (isRetina && isTall) {
          iosDeviceString += is64bit ? " (4-inch 64-bit)" : " (4-inch)";
        } else if (deviceName.toLowerCase().indexOf("3.5") !== -1) {
          iosDeviceString += " (3.5-inch)";
        }
      } else {
        iosDeviceString += is64bit ? " (64-bit)" : "";
      }
    } else if (opts.xcodeVersion[0] === '6') {
      iosDeviceString = opts.deviceName ||
        (isiPhone ? "iPhone Simulator" : "iPad Simulator");
    }
    let reqVersion = opts.platformVersion || opts.iOSSDKVersion;
    if (opts.iOSSDKVersion >= 8) {
      iosDeviceString += " (" + reqVersion + " Simulator)";
    } else if (opts.iOSSDKVersion >= 7.1) {
      iosDeviceString += " - Simulator - iOS " + reqVersion;
    }
    if (fixDevice) {
      // Some device config are broken in 5.1
      let CONFIG_FIX = {
        'iPhone - Simulator - iOS 7.1': 'iPhone Retina (4-inch 64-bit) - ' +
                                        'Simulator - iOS 7.1',
        'iPad - Simulator - iOS 7.1': 'iPad Retina (64-bit) - Simulator - ' +
                                      'iOS 7.1',
        'iPad Simulator (8.0 Simulator)': 'iPad 2 (8.0 Simulator)',
        'iPad Simulator (8.1 Simulator)': 'iPad 2 (8.1 Simulator)',
        'iPad Simulator (8.2 Simulator)': 'iPad 2 (8.2 Simulator)',
        'iPad Simulator (8.3 Simulator)': 'iPad 2 (8.3 Simulator)',
        'iPad Simulator (8.4 Simulator)': 'iPad 2 (8.4 Simulator)',
        'iPad Simulator (7.1 Simulator)': 'iPad 2 (7.1 Simulator)',
        'iPhone Simulator (8.4 Simulator)': 'iPhone 6 (8.4 Simulator)',
        'iPhone Simulator (8.3 Simulator)': 'iPhone 6 (8.3 Simulator)',
        'iPhone Simulator (8.2 Simulator)': 'iPhone 6 (8.2 Simulator)',
        'iPhone Simulator (8.1 Simulator)': 'iPhone 6 (8.1 Simulator)',
        'iPhone Simulator (8.0 Simulator)': 'iPhone 6 (8.0 Simulator)',
        'iPhone Simulator (7.1 Simulator)': 'iPhone 5s (7.1 Simulator)'
      };
      if (CONFIG_FIX[iosDeviceString]) {
        let oldDeviceString = iosDeviceString;
        iosDeviceString = CONFIG_FIX[iosDeviceString];
        logger.debug("Fixing device. Changed from: \"" + oldDeviceString +
                     "\" to: \"" + iosDeviceString + "\"");
      }
    }
    logger.debug("Final device string is: '" + iosDeviceString + "'");
    return iosDeviceString;
  }

  getDeviceString () {
    let opts = _.clone(this.args);
    _.extend(opts, {
      xcodeVersion: this.xcodeVersion,
      iOSSDKVersion: this.iOSSDKVersion
    });
    return IOS.getDeviceStringFromOpts(opts);
  }

  async setDeviceTypeInInfoPlist () {
    let plist = path.resolve(this.args.app, "Info.plist");
    let dString = this.getDeviceString();
    let isiPhone = dString.toLowerCase().indexOf("ipad") === -1;
    let deviceTypeCode = isiPhone ? 1 : 2;
    await updatePlistFile(plist, {UIDeviceFamily: [deviceTypeCode]});
  }

  async getBundleIdFromApp () {
    logger.debug("Getting bundle ID from app");
    let plist = path.resolve(this.args.app, "Info.plist");
    let obj;
    try {
      obj = await parsePlistFile(plist);
    } catch (err) {
      logger.error("Could not get the bundleId from app.");
      throw err;
    }
    return obj.CFBundleIdentifier;
  }

  static getSimForDeviceString (dString, availDevices) {
    let matchedDevice = null;
    let matchedUdid = null;
    _.each(availDevices, function (device) {
      if (device.indexOf(dString) !== -1) {
        matchedDevice = device;
        try {
          matchedUdid = /.+\[([^\]]+)\]/.exec(device)[1];
        } catch (e) {
          matchedUdid = null;
        }
      }
    });
    return [matchedDevice, matchedUdid];
  }

  async checkSimAvailable () {
    if (this.args.udid) {
      logger.debug("Not checking whether simulator is available since we're on " +
                   "a real device");
      return;
    }

    if (this.iOSSDKVersion < 7.1) {
      logger.debug("Instruments v < 7.1, not checking device string support");
      return;
    }

    logger.debug("Checking whether instruments supports our device string");
    let availDevices = await B.fromNode(Instruments.getAvailableDevicesWithRetry.bind(null, 3));
    let dString = this.getDeviceString();
    let noDevicesError = function () {
      let msg = "Could not find a device to launch. You requested '" +
                dString + "', but the available devices were: " +
                JSON.stringify(availDevices);
      logger.error(msg);
      throw new Error(msg);
    };
    if (this.iOSSDKVersion >= 8) {
      let sim = IOS.getSimForDeviceString(dString, availDevices);
      if (sim[0] === null || sim[1] === null) {
        noDevicesError();
      }
      this.iOSSimUdid = sim[1];
      logger.debug("iOS sim UDID is " + this.iOSSimUdid);
    } else if (!_.contains(availDevices, dString)) {
      noDevicesError();
    }
  }

  async setDeviceInfo () {
    this.shouldPrelaunchSimulator = false;
    if (this.args.udid) {
      logger.debug("Not setting device type since we're on a real device");
      return;
    }

    if (!this.args.app && this.args.bundleId) {
      logger.debug("Not setting device type since we're using bundle ID and " +
                  "assuming app is already installed");
      return;
    }

    if (!this.args.deviceName &&
        this.args.forceIphone === null &&
        this.args.forceIpad === null) {
      logger.debug("No device specified, current device in the iOS " +
                   "simulator will be used.");
      return;
    }

    if (this.args.defaultDevice || this.iOSSDKVersion >= 7.1) {
      if (this.iOSSDKVersion >= 7.1) {
        logger.debug("We're on iOS7.1+ so forcing defaultDevice on");
      } else {
        logger.debug("User specified default device, letting instruments launch it");
      }
    } else {
      this.shouldPrelaunchSimulator = true;
    }
    await this.setDeviceTypeInInfoPlist();
  }

  async createSimulator () {
    this.sim = new Simulator({
      platformVer: this.args.platformVersion,
      sdkVer: this.iOSSDKVersion,
      udid: this.iOSSimUdid
    });
  }

  async _moveBuiltInApp () {
    if (this.appString().toLowerCase() === "settings") {
      logger.debug("Trying to use settings app, version " +
                   this.args.platformVersion);
      let attemptedApp, origApp;
      try {
        [attemptedApp, origApp ] = await B.fromNode(this.sim.preparePreferencesApp.bind(this.sim, this.args.tmpDir));
      } catch (err) {
        logger.error("Could not prepare settings app: " + err);
        throw err;
      }
      logger.debug("Using settings app at " + attemptedApp);
      this.args.app = attemptedApp;
      this.args.origAppPath = origApp;
    }
  }

  moveBuiltInApp (cb) {
    B.resolve(this._moveBuiltInApp()).nodeify(cb);
  }

  async prelaunchSimulator () {
    let msg;
    if (!this.shouldPrelaunchSimulator) {
      logger.debug("Not pre-launching simulator");
      return;
    }

    let xcodePath;
    try {
      xcodePath = await B.fromNode(xcode.getPath.bind(null));
    } catch (err) {
      throw new Error('Could not find xcode folder. Needed to start simulator. ' + err.message);
    }
    logger.debug("Pre-launching simulator");
    let iosSimPath = path.resolve(xcodePath,
        "Platforms/iPhoneSimulator.platform/Developer/Applications" +
        "/iPhone Simulator.app/Contents/MacOS/iPhone Simulator");
    if (!await _fs.exists(iosSimPath)) {
      msg = "Could not find ios simulator binary at " + iosSimPath;
      logger.error(msg);
      throw new Error(msg);
    }
    await this.endSimulator();
    logger.debug("Launching device: " + this.getDeviceString());
    let iosSimArgs = ["-SimulateDevice", this.getDeviceString()];
    this.iosSimProcess = spawn(iosSimPath, iosSimArgs);
    await new B.Promise(function(resolve) {
      // TODO: this should be done by simulator, so not touching it for now
      let waitForSimulatorLogs = (countdown) => {
        if (countdown <= 0 ||
          (this.logs.syslog && (this.logs.syslog.getAllLogs().length > 0 ||
          (this.logs.crashlog && this.logs.crashlog.getAllLogs().length > 0)))) {
          logger.debug(countdown > 0 ? "Simulator is now ready." :
                       "Waited 10 seconds for simulator to start.");
          resolve();
        } else {
          setTimeout(function () {
            waitForSimulatorLogs(countdown - 1);
          }, 1000);
        }
      };
      waitForSimulatorLogs(10);
    });
  }

  async _parseLocalizableStrings (language, stringFile) {
    if (this.args.app === null) {
      logger.debug("Localizable.strings is not currently supported when using real devices.");
      return;
    }
    language = language || this.args.language;
    stringFile = stringFile || "Localizable.strings";
    let strings = null;

    if (language) {
      strings = path.resolve(this.args.app, language + ".lproj", stringFile);
    }
    if (!await _fs.exists(strings)) {
      if (language) {
        logger.debug("No strings file '" + stringFile + "' for language '" + language + "', getting default strings");
      }
      strings = path.resolve(this.args.app, stringFile);
    }
    if (!await _fs.exists(strings)) {
      strings = path.resolve(this.args.app, this.args.localizableStringsDir, stringFile);
    }

    let obj;
    try {
      obj = parsePlistFile(strings);
      logger.debug("Parsed app " + stringFile);
      this.localizableStrings = obj;
    } catch (err) {
      logger.warn("Could not parse app " + stringFile +" assuming it " +
                  "doesn't exist");
    }
  }

  parseLocalizableStrings (language, stringFile, cb) {
    B.resolve(this._parseLocalizableStrings(language, stringFile)).nodeify(cb);
  }

  async deleteSim () {
    await B.fromNode(this.sim.deleteSim.bind(this.sim));
  }

  async _clearAppData  () {
    if (!this.keepAppToRetainPrefs && this.args.app && this.args.bundleId) {
      this.sim.cleanCustomApp(path.basename(this.args.app), this.args.bundleId);
    }
  }

  clearAppData  (cb) {
    B.resolve(this._clearAppData()).nodeify(cb);
  }

  async cleanupSimState () {
    if (this.realDevice && this.args.bundleId && this.args.fullReset) {
      logger.debug("fullReset requested. Will try to uninstall the app.");
      let bundleId = this.args.bundleId;
      try {
        await B.fromNode(this.realDevice.remove.bind(this.realDevice, bundleId));
      } catch (err) {
        try {
          await B.fromNode(this.removeApp.bind(this, bundleId));
        } catch(err) {
          logger.error("Could not remove " + bundleId + " from device");
          throw err;
        }
        logger.debug("Removed " + bundleId);
        return;
      }
      logger.debug("Removed " + bundleId);
    } else if (!this.args.udid) {
      try {
        B.fromNode(this.sim.cleanSim.bind(this.sim, this.args.keepKeyChains, this.args.tmpDir));
      } catch (err) {
        logger.error("Could not reset simulator. Leaving as is. Error: " + err.message);
      }
      await this._clearAppData();
    } else {
      logger.debug("On a real device; cannot clean device state");
    }
  }

  async runSimReset () {
    if (this.args.reset || this.args.fullReset) {
      logger.debug("Running ios sim reset flow");
      // The simulator process must be ended before we delete applications.
      await this.endSimulator();
      if (this.args.reset) {
        await this.cleanupSimState();
      }
      if (this.args.fullReset && !this.args.udid) {
        await this.deleteSim();
      }
    } else {
      logger.debug("Reset not set, not ending sim or cleaning up app state");
    }
  }

  async isolateSimDevice () {
    if (!this.args.udid && this.args.isolateSimDevice &&
        this.iOSSDKVersion >= 8) {
      await B.fromNode(this.sim.deleteOtherSims.bind(this.sim));
    }
  }

  async postCleanup () {
    this.curCoords = null;
    this.curOrientation = null;

    if (!_.isEmpty(this.logs)) {
      this.logs.syslog.stopCapture();
      this.logs = {};
    }

    if (this.remote) {
      this.stopRemote();
    }

    // ignore any errors during reset and continue shutting down
    try { await this.runSimReset(); } catch (ign) {}
    this.isShuttingDown = false;
  }

  async endSimulator () {
    logger.debug("Killing the simulator process");
    if (this.iosSimProcess) {
      this.iosSimProcess.kill("SIGHUP");
      this.iosSimProcess = null;
    } else {
      Instruments.killAllSim();
    }
    await this.endSimulatorDaemons();
  }

  async endSimulatorDaemons () {
    logger.debug("Killing any other simulator daemons");
    let stopCmd = 'launchctl list | grep com.apple.iphonesimulator | cut -f 3 | xargs -n 1 launchctl stop';
    await B.fromNode(exec.bind(null, stopCmd, { maxBuffer: 524288 }));
    let removeCmd = 'launchctl list | grep com.apple.iphonesimulator | cut -f 3 | xargs -n 1 launchctl remove';
    await B.fromNode(exec.bind(null, removeCmd, { maxBuffer: 524288 }));
  }

  async _stop () {
    logger.debug("Stopping ios");
    if (this.instruments === null) {
      logger.debug("Trying to stop instruments but it already exited");
      await this.postCleanup();
    } else {
      try {
        await B.fromNode(this.commandProxy.shutdown.bind(this.commandProxy));
      } catch (err) {
        logger.warn("Got warning when trying to close command proxy:", err);
      }
      let code = await new B.Promise((resolve) => {
        this.instruments.shutdown(function (code) {
          resolve(code);
        });
      });
      await this._shutdown(code);
    }
  }

  stop (cb) {
    B.resolve(this._stop()).nodeify(cb);
  }

  async _shutdown () {
    this.commandProxy = null;
    this.instruments = null;
    await this.postCleanup();
  }

  shutdown (cb) {
    B.resolve(this._shutdown()).nodeify(cb);
  }

  initQueue () {

    this.queue = asynclib.queue(function (command, cb) {
      if (!this.commandProxy) return cb();
      asynclib.series([
        function (cb) {
          asynclib.whilst(
            function () { return this.selectingNewPage && this.curContext; }.bind(this),
            function (cb) {
              logger.debug("We're in the middle of selecting a new page, " +
                          "waiting to run next command until done");
              setTimeout(cb, 100);
            },
            cb
          );
        }.bind(this),
        function (cb) {
          let matched = false;
          let matches = ["au.alertIsPresent", "au.getAlertText", "au.acceptAlert",
                         "au.dismissAlert", "au.setAlertText",
                         "au.waitForAlertToClose"];
          _.each(matches, function (match) {
            if (command.indexOf(match) === 0) {
              matched = true;
            }
          });
          asynclib.whilst(
            function () { return !matched && this.curContext && this.processingRemoteCmd; }.bind(this),
            function (cb) {
              logger.debug("We're in the middle of processing a remote debugger " +
                          "command, waiting to run next command until done");
              setTimeout(cb, 100);
            },
            cb
          );
        }.bind(this)
      ], function (err) {
        if (err) return cb(err);
        this.cbForCurrentCmd = cb;
        if (this.commandProxy) {
          this.commandProxy.sendCommand(command, function (response) {
            this.cbForCurrentCmd = null;
            if (typeof cb === 'function') {
              this.respond(response, cb);
            }
          }.bind(this));
        }
      }.bind(this));
    }.bind(this), 1);
  }

  push (elem) {
    this.queue.push(elem[0], elem[1]);
  }

  isAppInstalled (bundleId, cb) {
    if (this.args.udid) {
      if (!this.realDevice) {
        try {
          this.realDevice = this.getIDeviceObj();
        } catch (e) {
          return cb(e);
        }
      }
      this.realDevice.isInstalled(bundleId, cb);
    } else {
      cb(new Error("You can not call isInstalled for the iOS simulator!"));
    }
  }

  removeApp (bundleId, cb) {
    if (this.args.udid) {
      if (!this.realDevice) {
        try {
          this.realDevice = this.getIDeviceObj();
        } catch (e) {
          return cb(e);
        }
      }
      this.realDevice.remove(bundleId, cb);
    } else {
      this.sim.remove(bundleId, cb);
    }
  }

  installApp (unzippedAppPath, cb) {
    if (this.args.udid) {
      if (!this.realDevice) {
        try {
          this.realDevice = this.getIDeviceObj();
        } catch (e) {
          return cb(e);
        }
      }
      this.realDevice.install(unzippedAppPath, cb);
    } else {
      this.sim.install(unzippedAppPath, cb);
    }
  }

  startApp (args, cb) {
    if (this.args.udid) {
      cb(new Error("You can not call startApp for a real device!"));
    } else {
      this.sim.launch(args.appPackage, cb);
    }
  }

  unpackApp (req, cb) {
    deviceCommon.unpackApp(req, '.app', cb);
  }

  startLogCapture (cb) {
    if (!_.isEmpty(this.logs)) {
      cb(new Error("Trying to start iOS log capture but it's already started!"));
      return;
    }
    this.logs.crashlog = new iOSCrashLog();
    this.logs.syslog = new iOSLog({
      udid: this.args.udid
    , simUdid: this.iOSSimUdid
    , showLogs: this.args.showSimulatorLog || this.args.showIOSLog
    });
    this.logs.syslog.startCapture(function (err) {
      if (err) {
        logger.warn("Could not capture logs from device. Continuing without capturing logs.");
        return cb();
      }
      this.logs.crashlog.startCapture(cb);
    }.bind(this));
  }

  initAutoWebview (cb) {
    if (this.args.autoWebview) {
      logger.debug('Setting auto webview');
      this.navToInitialWebview(cb);
    } else {
      cb();
    }
  }

  getContextsAndViews (cb) {
    this.listWebFrames(function (err, webviews) {
      if (err) return cb(err);
      let ctxs = [{id: this.NATIVE_WIN}];
      this.contexts = [this.NATIVE_WIN];
      _.each(webviews, function (view) {
        ctxs.push({id: this.WEBVIEW_BASE + view.id, view: view});
        this.contexts.push(view.id.toString());
      }.bind(this));
      cb(null, ctxs);
    }.bind(this));
  }

  getLatestWebviewContextForTitle (titleRegex, cb) {
    this.getContextsAndViews(function (err, contexts) {
      if (err) return cb(err);
      let matchingCtx;
      _(contexts).each(function (ctx) {
        if (ctx.view && (ctx.view.title || "").match(titleRegex)) {
          if (ctx.view.url === "about:blank") {
            // in the case of Xcode  < 5 (i.e., iOS SDK Version less than 7)
            // and in the case of iOS 7.1 in a webview (not in Safari)
            // we can have the url be `about:blank`
            if (parseFloat(this.iOSSDKVersion) < 7 ||
                (this.args.platformVersion === '7.1' && this.args.app && this.args.app.toLowerCase() !== 'safari')) {
              matchingCtx = ctx;
            }
          } else {
            matchingCtx = ctx;
          }
        }
      }.bind(this));
      cb(null, matchingCtx ? matchingCtx.id : undefined);
    }.bind(this));
  }

  // Right now we don't necessarily wait for webview
  // and frame to load, which leads to race conditions and flakiness
  // , let see if we can transition to something better
  useNewSafari () {
    return parseFloat(this.iOSSDKVersion) >= 8.1 &&
           parseFloat(this.args.platformVersion) >= 8.1 &&
           !this.args.udid &&
           this.capabilities.safari;
  }

  navToInitialWebview (cb) {
    let timeout = 0;
    if (this.args.udid) {
      timeout = 3000;
      logger.debug('Waiting for ' + timeout + ' ms before navigating to view.');
    }

    setTimeout(function () {
      if (this.useNewSafari()) {
        return this.typeAndNavToUrl(cb);
      } else if (parseInt(this.iOSSDKVersion, 10) >= 7 && !this.args.udid && this.capabilities.safari) {
        this.navToViewThroughFavorites(cb);
      } else {
        this.navToViewWithTitle(/.*/, cb);
      }
    }.bind(this), timeout);
  }

  typeAndNavToUrl (cb) {
    let initialUrl = this.args.safariInitialUrl || 'http://127.0.0.1:' + this.args.port + '/welcome';
    let oldImpWait = this.implicitWaitMs;
    this.implicitWaitMs = 7000;
    function noArgsCb(cb) { return function (err) { cb(err); }; }
    asynclib.waterfall([
      this.findElement.bind(this, 'name', 'URL'),
      function (res, cb) {
        this.implicitWaitMs = oldImpWait;
        this.nativeTap(res.value.ELEMENT, noArgsCb(cb));
      }.bind(this),
      this.findElements.bind(this, 'name', 'Address'),
      function (res, cb) {
        let addressEl = res.value[res.value.length -1].ELEMENT;
        this.setValueImmediate(addressEl, initialUrl, noArgsCb(cb));
      }.bind(this),
      this.findElement.bind(this, 'name', 'go'),
      function (res, cb) {
        this.nativeTap(res.value.ELEMENT, noArgsCb(cb));
      }.bind(this)
    ], function () {
      this.navToViewWithTitle(/.*/i, function (err) {
        if (err) return cb(err);
        // Waits for page to finish loading.
        this.remote.pageUnload(cb);
      }.bind(this));
    }.bind(this));
  }

  navToViewThroughFavorites (cb) {
    logger.debug("We're on iOS7+ simulator: clicking apple button to get into " +
                "a webview");
    let oldImpWait = this.implicitWaitMs;
    this.implicitWaitMs = 7000; // wait 7s for apple button to exist
    this.findElement('xpath', '//UIAScrollView[1]/UIAButton[1]', function (err, res) {
      this.implicitWaitMs = oldImpWait;
      if (err || res.status !== status.codes.Success.code) {
        let msg = "Could not find button to click to get into webview. " +
                  "Proceeding on the assumption we have a working one.";
        logger.error(msg);
        return this.navToViewWithTitle(/.*/i, cb);
      }
      this.nativeTap(res.value.ELEMENT, function (err, res) {
        if (err || res.status !== status.codes.Success.code) {
          let msg = "Could not click button to get into webview. " +
                    "Proceeding on the assumption we have a working one.";
          logger.error(msg);
        }
        this.navToViewWithTitle(/apple/i, cb);
      }.bind(this));
    }.bind(this));
  }

  navToViewWithTitle (titleRegex, cb) {
    logger.debug("Navigating to most recently opened webview");
    let start = Date.now();
    let spinTime = 500;
    let spinHandles = function () {
      this.getLatestWebviewContextForTitle(titleRegex, function (err, res) {
        if (err) {
          cb(new Error("Could not navigate to webview! Err: " + err));
        } else if (!res) {
          if ((Date.now() - start) < 90000) {
            logger.warn("Could not find any webviews yet, refreshing/retrying");
            if (this.args.udid || !this.capabilities.safari) {
              return setTimeout(spinHandles, spinTime);
            }
            this.findUIElementOrElements('accessibility id', 'ReloadButton',
                '', false, function (err, res) {
              if (err || !res || !res.value || !res.value.ELEMENT) {
                logger.warn("Could not find reload button, continuing");
                setTimeout(spinHandles, spinTime);
              } else {
                this.nativeTap(res.value.ELEMENT, function (err, res) {
                  if (err || !res) {
                    logger.warn("Could not click reload button, continuing");
                  }
                  setTimeout(spinHandles, spinTime);
                }.bind(this));
              }
            }.bind(this));
          } else {
            cb(new Error("Could not navigate to webview; there aren't any!"));
          }
        } else {
          let latestWindow = res;
          logger.debug("Picking webview " + latestWindow);
          this.setContext(latestWindow, function (err) {
            if (err) return cb(err);
            this.remote.cancelPageLoad();
            cb();
          }.bind(this), true);
        }
      }.bind(this));
    }.bind(this);
    spinHandles();
  }

}

IOS.prototype.resetTimeout = deviceCommon.resetTimeout;
IOS.prototype.waitForCondition = deviceCommon.waitForCondition;
IOS.prototype.implicitWaitForCondition = deviceCommon.implicitWaitForCondition;
IOS.prototype.proxy = deviceCommon.proxy;
IOS.prototype.proxyWithMinTime = deviceCommon.proxyWithMinTime;
IOS.prototype.respond = deviceCommon.respond;
IOS.prototype.getSettings = deviceCommon.getSettings;
IOS.prototype.updateSettings = deviceCommon.updateSettings;


_.extend(IOS.prototype, iOSHybrid);
_.extend(IOS.prototype, iOSController);

module.exports = IOS;
