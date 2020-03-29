// Node.js Interface for UDI Cloud Polyglot NodeServers
// Written by Benoit Mercier

'use strict';

const fs = require('fs');
const events = require('events');
// const zlib = require('zlib');
const mqtt = require('mqtt');
const logger = require('./logger.js');
const Queue = require('./Queue.js');
const Node = require('./Node.js');

// This is the interface class to Polyglot
module.exports = class Interface extends events.EventEmitter {
  // All node classes have to be declared to the interface
  constructor(declaredNodeClasses) {
    super();
    const _this = this;

    this.isCloud = true; // Allows the nodeserver to detect if using PGC

    // MQTT Host and port
    this._mqttHost = process.env.MQTTENDPOINT;
    this._mqttPort = 8883;

    this._stage = process.env.STAGE;

    // We need the profileNum, userId & Worker from env var NODESERVER
    try {
      // Read NODESERVER environment variable which contains initial config
      this._config = JSON.parse(process.env.NODESERVER);
      // console.log('unparsed config:', process.env.NODESERVER);

      // ISY Profile number (int)
      this._profileNum = typeof this._config.profileNum === 'string' ?
        parseInt(this._config.profileNum, 10) :
        this._config.profileNum;

      this._userId = this._config.userId;
      this._worker = this._config.worker;
      this._id = this._config.id;
    } catch (err) {
      logger.errorStack(err, 'Error reading nodeserver config:');
    }

    this._clientId = `${this._worker}_${this._profileNum}_${this._userId}`;

    this._recvTopic = `${this._stage}/ns/${this._worker}`;
    this._sendTopic = `${this._stage}/ns`;
    this._logTopic = `${this._stage}/frontend/${this._userId}/logs/` +
      `${this._worker}`;

    // Tells us which clientIds are subscribed to the logs
    this._mqttLogObservers = {};

    logger.info('Polyglot topic: %s', _this._recvTopic);

    // To override the logTopic for testing:
    logger.info('Logging topic: %s', this._logTopic);

    // Sample message
    // {
    //   "name": "pgc_interface.pgc_interface",
    //   "processName": "MainProcess",
    //   "filename": "ecobee-poly.py",
    //   "funcName": "_getTokens",
    //   "levelname": "DEBUG",
    //   "lineno": 154,
    //   "module": "ecobee-poly",
    //   "threadName": "NodeServer",
    //   "message": "PIN: vary found. Attempting to get tokens...",
    //   "timestamp": 1551747113383
    // }

    // Converts winston log data to Polyglot format
    // Used for historical & real-time log data
    this._mqttLogMapper = function(info) {
      return {
        // name: 'pgc_interface.pgc_interface',
        // processName: 'MainProcess',
        // filename: 'pgc_interface.py',
        // funcName: '_mqttLogHandler',
        levelname: info.level.toUpperCase(),
        // lineno: 365,
        // module: 'pgc_interface',
        threadName: info.label,
        message: info.message,
        timestamp: new Date(info.timestamp).valueOf(),
      };
    };

    // this._mqttTransport = new (logger.MqttTransport)({
    //   handleExceptions: true,
    //   level: 'debug',
    //   mqttHandler: function(info) {
    //     _this._mqttClient.publish(_this._logTopic,
    //       JSON.stringify(_this._mqttLogMapper(info))
    //     );
    //   },
    // });

    // This is the mqtt client, the result of mqtt.connect()
    this._mqttClient = null;

    // Are we connected to the queue?
    this._mqttClientConnected = false;

    // Some polyglot messages are queued for processing in this queue
    this._queue = new Queue(
      this._onMessageQueued,
      this,
      'Message Queue Processor');

    // We use this to track the messages sent to Polyglot
    // We do this to return the response to sendMessageAsync
    this._messageAsyncTracking = {};

    // true if we received stop or delete
    this._shuttingDown = false;

    // These are the declared nodes classes (see below)
    this._nodeClasses = {};

    // This is our nodes with the classes applied to them
    this._nodes = {};

    // We use this to detect config sent continuously in a loop
    this._configCounter = 0;

    // Set this_nodeClasses correctly on startup
    declaredNodeClasses.forEach(function(nodeClass) {
      _this._nodeClasses[nodeClass.nodeDefId] = nodeClass;
    });
  }

  // Starts the interface by getting MQTT parameters from stdin
  async start() {
    logger.info('Interface starting');

    const _this = this;

    const sslOptions = {
      // Working dir should be /app/nodeserver
      key: fs.readFileSync('../certs/private.key'),
      cert: fs.readFileSync('../certs/iot.crt'),
      ca: [fs.readFileSync('../certs/AmazonRootCA1.pem')],
    };

    const mqttOptions = {
      port: this._mqttPort,
      clientId: 'mqttjs_' + Math.random().toString(16).substr(2, 8),
      // username: 'admin',
      // password: 'admin',
      rejectUnauthorized: true,
      resubscribe: true,

      // Will send this payload if it disconnects. This does not work.
      // will: {
      //   topic: this._sendTopic,
      //   payload: JSON.stringify({
      //     connected: false,
      //     topic: this._recvTopic,
      //     userId: this._userId,
      //     profileNum: '' + this._profileNum,
      //     id: '' + this._id,
      //   }),
      // },
    };

    this._mqttClient = mqtt.connect('mqtts://' + this._mqttHost,
      Object.assign({}, sslOptions, mqttOptions));

    this._mqttClient.on('error', () => {
      logger.error('MQTT Error');
    });

    this._mqttClient.on('connect', () => {
      try {
        logger.info('MQTT client connected');
        _this._mqttClientConnected = true;

        _this._mqttClient.subscribe(_this._recvTopic);

        _this._sendMessage({ connected: true });

        _this.emit('mqttConnected');

        // PGC does not send config on first connect.
        // We need to use the one received from NODESERVER env
        _this._onConfig(this._config, true);
      } catch (err) {
        logger.errorStack(err, 'Error on MQTT connect handler:');
      }
    });

    this._mqttClient.on('message', (topic, message) => {
      // We can get empty messages, such as when deleting the nodeserver
      if (message.length) {
        try {
          const parsedMessage = JSON.parse(message);
          _this._onMessage(parsedMessage);
        } catch (err) {
          logger.errorStack(err, 'Error processing %s:',
            _this._mqttTopicPolyglotConnection);
        }
      }
    });

    this._mqttClient.on('reconnect', () => {
      _this._mqttClientConnected = true;
      _this.emit('mqttReconnect');
    });

    this._mqttClient.on('offline', () => {
      _this._mqttClientConnected = false;
      _this.emit('mqttOffline');
    });

    this._mqttClient.on('close', () => {
      _this._mqttClientConnected = false;
      _this.emit('mqttClose');
    });

    this._mqttClient.on('end', () => {
      _this._mqttClientConnected = false;
      _this.emit('mqttEnd');
    });
  }

  stop() {
    // This also sends the MQTT will (tells Polyglot it is disconnected)
    this._sendMessage({ connected: false });
    this._mqttClient.end();
    clearInterval(this['shortPollTimer']);
    clearInterval(this['longPollTimer']);
  }

  // Handler for incoming Polyglot messages
  _onMessage(message) {
    const _this = this;
    this.emit('messageReceived', message);

    const queuedMessages = [ 'config', 'query', 'command', 'status', 'polls',
      'oauth', 'startLogStream', 'stopLogStream', // 'tailLog', 'removeTail',
    ];

    const ignoredMessages = [
      'userId', 'clientId', 'id', 'profileNum',
    ];

    // delete message.node; // Ignore the node property. We no longer need it.

    Object.keys(message).forEach(function(messageKey) {
      const messageContent = message[messageKey];
      switch (messageKey) {
        case 'result':
          _this._onResult(messageContent);
          break;

        case 'stop':
          logger.warn('Received stop message');
          _this._shuttingDown = true;
          _this.emit('stop');
          break;

        // No longer used?
        case 'delete':
          logger.warn('Received delete message');
          _this._shuttingDown = true;
          _this.emit('delete');
          break;

        default:
          if (queuedMessages.includes(messageKey)) {
            // The other messages are queued to be run sequentially
            // by this._onMessageQueued
            _this._queue.add({
              // We set it here to facilitate routing to the proper function
              messageKey: messageKey,
              messageContent: messageContent,
              clientId: message.clientId ? message.clientId : null,
            });
          } else if (ignoredMessages.includes(messageKey)) {
            // logger.debug('Message key %s ignored', messageKey);
          } else {
            logger.error('Invalid message %s received %o:',
              messageKey, message);
          }
      }
    });
  }

  // Handler for Polyglot messages that are queued
  async _onMessageQueued(opt) {
    const _this = this;
    const messageKey = opt.messageKey;
    const messageContent = opt.messageContent;

    if (!this._shuttingDown) {
      let node;
      switch (messageKey) {
        case 'config':
          _this._onConfig(messageContent);
          break;

        case 'query':
          node = _this.getNode(messageContent.address);
          if (node) {
            return node.query();
          }
          break;

        case 'status':
          node = _this.getNode(messageContent.address);
          if (node) {
            return node.status();
          }
          break;

        case 'command':
          node = _this.getNode(messageContent.address);
          if (node) {
            // Example messageContent: {
            //  address: 'node003',
            //  cmd: 'DON',
            //  value: '6',
            //  uom: '51'
            // }
            await node.runCmd(messageContent);
            if (messageContent.hasOwnProperty('query') &&
              messageContent.query.hasOwnProperty('requestId')) {
              this._sendMessage({
                report: {
                  requestId: messageContent.query.requestId,
                  success: true,
                },
              }, 'isy');
            }
          }
          break;

        case 'polls':
          // Change poll frequency if required
          this._config.shortPoll = messageContent.shortPoll;
          this._config.longPoll = messageContent.longPoll;
          this._checkPollingInterval('short', messageContent.shortPoll);
          this._checkPollingInterval('long', messageContent.longPoll);
          break;

        case 'oauth':
          this.emit('oauth', messageContent);
          break;

          // PGC now only uses stdout
          // case 'startLogStream':
          //   this._startLogStream(opt.clientId);
          //   break;

          // case 'stopLogStream':
          //   this._stopLogStream(opt.clientId);
          //   break;

        default:
          logger.error('Invalid queued message %s received %o:',
            messageKey, messageContent);
      }
    } else {
      logger.warn('Message %s ignored: Shutting down nodeserver', messageKey);
    }
  }

  // Sets a newParamsDetected flag to the newConfig object
  _setParamsDetected(oldConfig, newConfig) {
    const oldConfigParamsKeys = oldConfig && oldConfig.customParams ?
      Object.keys(oldConfig.customParams) : [];
    const newConfigParamsKeys = newConfig && newConfig.customParams ?
      Object.keys(newConfig.customParams) : [];

    const changedParams = newConfigParamsKeys.filter(function(key) {
      return !(oldConfigParamsKeys.includes(key) &&
        oldConfig.customParams[key] === newConfig.customParams[key]);
    });

    newConfig.newParamsDetected = changedParams.length !== 0;
  }

  // Handler for the config message
  _onConfig(config, isInitialConfig = false) {
    const _this = this;

    // Some of the properties received are converted
    const propertyMapper = {
      // controller: function(val) {
      //   // Return boolean
      //   return typeof val === 'string' ? val === 'true' : val;
      // },
      timeAdded: function(t) {
        // Return a Date object
        return typeof t === 'string' ? new Date(parseInt(t, 10)) : t;
      },
      profileNum: function(val) {
        // Return boolean
        return typeof val === 'string' ? val === 'true' : val;
      },
    };

    // Use the nodes configuration we get from the config to build the Nodes
    // with the class (Sets up this._nodes)
    Object.keys(config.nodes).forEach(function(address) {
      const n = config.nodes[address];
      let node;

      // If this node does not exists yet in this._nodes, create it
      if (!_this._nodes[address]) {
        const NodeClass = _this._nodeClasses[n.nodedefid];
        const primary = n.primary.slice(5);

        if (NodeClass) {
          node = new NodeClass(_this, primary, address, n.name);

          // Convert drivers, in case they are not correctly defined
          node.convertDrivers();

          _this._nodes[address] = node;
        } else {
          logger.error('Config node with address %s has an invalid class %s',
            address, n.nodedef);
        }
      } else {
        node = _this._nodes[address];
      }

      // If node did not have a valid class, we just ignore it
      if (node) {
        // node is either a new node, or the existing node.
        // Update the properties of the node with the config
        ['controller', 'drivers', 'isprimary', 'profileNum', 'timeAdded']
        .forEach(function(prop) {
          if (prop in n) {
            // logger.info('prop in n %s %s', prop, n[prop])
            if (propertyMapper[prop]) {
              node[prop] = propertyMapper[prop](n[prop]);
            } else {
              node[prop] = n[prop];
            }
          }
        });
      }
    });

    // Remove nodes from this._nodes that are no longer in the config
    if (Object.keys(config.nodes).length !== Object.keys(_this._nodes).length) {
      Object.keys(_this._nodes).forEach(function(address) {
        const found = config.nodes[address];

        if (!found) {
          logger.info('Node %s was removed from the config', address);
          delete _this._nodes[address];
        }
      });
    }

    // Sets the newParamsDetected flag in the config
    this._setParamsDetected(this._config, config);

    this._config = config;

    // Start/Restart polling, if required.
    this._checkPollingInterval('short', config.shortPoll);
    this._checkPollingInterval('long', config.longPoll);

    // Let the node server know we have received a config
    // Processes the config, unless we are detecting a loop
    if (!this._detectConfigLoop()) {
      this.emit('config', Object.assign({}, config, {
        isInitialConfig: isInitialConfig,
        nodes: this._nodes,
      }));
    } else {
      logger.error('Config processing loop detected iteration %d. ' +
        'Skipping config processing.', _this._configCounter);
    }
  }

  // Used to detect if we get configs looping
  _detectConfigLoop() {
    const _this = this;
    this._configCounter++;

    setTimeout(function() {
      _this._configCounter--;
    }, 10000);

    // Trigger is over 30 configs within 10 seconds
    return this._configCounter > 30;
  }

  // Starts/Restarts polling for poll=='short' or poll=='long' if changed
  _checkPollingInterval(poll, newValue) {
    const valueProp = poll + 'PollValue'; // shortPollValue | longPollValue
    const timerProp = poll + 'PollTimer'; // shortPollTimer | longPollTimer

    if (this[valueProp] !== newValue) {

      if (this[valueProp]) {
        logger.info('Change %sPoll value from %s to %s',
          poll, this[valueProp], newValue);
      } else {
        logger.info('Set %sPoll value to %s', poll, newValue);
      }

      // If polling is already active, we need to stop it first.
      if (this[timerProp]) {
        clearInterval(this[timerProp]);
      }

      this[valueProp] = newValue;

      // setInterval will keep a reference to this bool, instead of the string
      const isLongPoll = poll === 'long';
      const _this = this;

      this[timerProp] = setInterval(function() {
        if (!_this._shuttingDown) {
          _this.emit('poll', isLongPoll);
        }
      }, _this[valueProp] * 1000);
    }
  }

  // Sample result message
  // {
  //     profileNum: '1',
  //     addnode: {
  //         success: true,
  //         reason: 'AddNode: n001_node006 added to database successfully.',
  //         address: 'node006'
  //     }
  // }

  // We can also have this message with a different format
  // {
  //     isyresponse: '',
  //     statusCode: 404,
  //     seq: false,
  //     elapsed: '15.02125ms',
  //     profileNum: '1',
  //     status: {
  //         success: false,
  //         reason: 'n001_controller or ST does not exist - ISY returned 404',
  //         address: 'n001_controller'
  //     }
  // }

  // Handle result messages (result of commands such as addnode)
  _onResult(messageContent) {
    const _this = this;
    const trackedCommands = ['addnode'];
    const ignoredKeys = [
      'removenode', 'profileNum',
      'statusCode', 'seq', 'elapsed', 'status', // isyresponse messages
    ];

    // Finds the tracked request, if exists, and resolve/reject it.
    Object.keys(messageContent).forEach(function(key) {
      if (trackedCommands.includes(key)) {
        const address = messageContent[key].address;
        const trackedRequest = _this._messageAsyncTracking[key + '-' + address];
        if (trackedRequest) {
          if (messageContent[key].success) {
            trackedRequest.resolve(messageContent[key].reason);
          } else {
            trackedRequest.reject(messageContent[key].reason);
          }
        }
      } else if (key === 'isyresponse') {
        try {
          logger.info('Received result ISY Response: %s',
            messageContent.status.reason);
        } catch (err) {
          logger.errorStack(err, 'Error on Received result:');
          logger.info('Received result ISY Response: %o', messageContent);
        }
      } else if (ignoredKeys.includes(key)) {
      } else {
        logger.info('Received result for unhandled command %s: %o',
          key, messageContent);
      }
    });
  }

  // Finds the controller node. null if there are none.
  _getController() {
    const _this = this;

    const controllers = Object.keys(this._nodes)
    .filter(function(address) {
      return _this._nodes[address].controller;
    })
    .map(function(address) {
      return _this._nodes[address];
    });

    if (controllers.length >= 2) {
      logger.warn('There are %d controllers.', controllers.length);
    }

    return controllers.length ? controllers[0] : null;
  }

  // Sends a message to Polyglot. Don't check the connection status,
  // don't wait for the result. Used internally only.
  _sendMessage(message, service = null) {
    // We need to add the node to the message (string)

    const topic = service ? `${this._stage}/${service}` : this._sendTopic;

    message.userId = this._userId;
    message.topic = this._recvTopic;
    message.profileNum = '' + this._profileNum;
    message.id = '' + this._id;

    this.emit('messageSent', message);

    this._mqttClient.publish(topic, JSON.stringify(message));
  }

  // Returns whether we are running on pgtest.isy.io or polyglot.isy.io
  getStage() {
    return process.env.STAGE; // 'test' | 'prod'
  }

  // Returns true if we are connected to MQTT.
  isConnected() {
    return this._mqttClientConnected;
  }

  // Sends a message to Polyglot. Don't wait for the result.
  sendMessage(message) {
    if (this.isConnected()) {
      this._sendMessage(message);
    }
  }

  // Sends a message to Polyglot. Wait for the result message
  async sendMessageAsync(key, message, timeout = 15000) {
    const _this = this;

    // If we have an existing promise for the same key, make sure it is
    // finished before starting a new one
    if (_this._messageAsyncTracking[key] &&
      _this._messageAsyncTracking[key].promise) {

      try {
        await _this._messageAsyncTracking[key].promise;
      } catch (e) {
      }
    }

    let newTracker = {};

    newTracker.promise = new Promise(function(resolve, reject) {
      if (_this.isConnected()) {
        newTracker.resolve = resolve;
        newTracker.reject = reject;

        _this._sendMessage(message);

        if (timeout) {
          // Fail the request if timeout is reached
          setTimeout(function() {
            let err = new Error('Polyglot result message not received');

            // Allows catch to detect if the error is due to a timeout.
            err.name = 'timeout';
            reject(err);
          }, timeout);
        }
      } else {
        reject(new Error('Polyglot not connected'));
      }
    });

    // When we get the result message, we have access to the resolve and
    // reject callbacks. The promise is also available so that the next
    // sendMessageAsync can wait for this one to finish
    _this._messageAsyncTracking[key] = newTracker;

    return newTracker.promise;
  }

  // Adds a new node to polyglot and ISY
  async addNode(node) {
    if (!node instanceof Node) {
      logger.error('addNode error: node is not an instance of Node class');
    } else {
      // Fix potentially ill-defined drivers before sending to PGC
      node.convertDrivers();

      let message = {
        addnode: {
          // nodes: [{
          address: node.address,
          name: node.name,
          nodedefid: node.id,
          primary: node.primary,
          isController: node.isController,
          drivers: node.drivers,
        },
      };

      if (node.hint && typeof node.hint === 'string') {
        message.addnode.hint = node.hint;
      }

      logger.info('Sending message', message);

      return await this.sendMessageAsync('addnode-' + node.address, message);
    }
  }

  // Return a copy of the existing config
  getConfig() {
    return Object.assign({}, this._config);
  }

  // Get all the nodes (with class applied)
  getNodes() {
    return this._nodes ? this._nodes : {};
  }

  // Get a single node
  getNode(address) {
    if (typeof address !== 'string') {
      logger.error('getNode error: Parameter is not a string');
    } else {
      const node = this._nodes[address];

      if (!node) {
        logger.error('Node %s not found', address);
      }

      return node;
    }
  }

  // Delete a single node
  delNode(node) {
    if (!node instanceof Node) {
      logger.error('delNode error: node is not an instance of Node class');
    } else {
      const message = { removenode: {address: node.address }};
      this.sendMessage(message);
    }
  }

  // Sends the profile to ISY is version in server.json is different than
  // installed version
  updateProfileIfNew() {
    try {
      const serverJson = JSON.parse(fs.readFileSync('server.json'));
      const currentVersion = serverJson.profile_version;
      const installedVersion = this.getCustomData('installedProfileVersion');
      if (currentVersion !== installedVersion) {
        logger.info('Profile update required, installed version is %s, ' +
          'current version is %s', installedVersion, currentVersion);
        this.updateProfile();
        this.addCustomData({ installedProfileVersion: currentVersion });
      } else {
        logger.info('Profile update not required, installed version is: %s',
          installedVersion);
      }
    } catch (err) {
      logger.error('updateProfileIfNew: Could not update profile: %s',
        err.message);
    }
  }

  // Sends the profile to ISY
  updateProfile() {
    const _this = this;
    const profileFolder = 'profile/';

    // Will upload 1 file in these folders - must have the correct extension
    const validFiles = {
      editor: { ext: 'xml' },
      nls: { ext: 'txt' },
      nodedef: {ext: 'xml' },
    };

    Object.keys(validFiles).forEach(function(folder) {
      const files = fs.readdirSync(profileFolder + folder);
      files.forEach(function(filename) {
        let fileFound = false; // Will send the first valid file per folders
        // If file extension is valid & we have not found a valid file yet
        if (filename.split('.')[1] === validFiles[folder].ext && !fileFound) {
          fileFound = true;
          const buf = fs.readFileSync(profileFolder + folder + '/' + filename);
          const message = {
            uploadProfile: {
              type: folder,
              filename: filename,
              payload: buf.toString('base64'),
            },
          };
          _this._sendMessage(message, 'isy');
        }
      });
    });
  }

  // Sends notices (Will overwrite existing ones)
  saveNotices(notices) {
    if (typeof notices !== 'object') {
      logger.error('saveNotices error: Parameter is not an object.');
    } else {
      const message = { notices: notices };
      this.sendMessage(message);
    }
  }

  // Get all notices
  getNotices() {
    return this._config.notices ? this._config.notices : {};
  }

  noticeExists(key) {
    return this.getNotices()[key];
  }

  // Add custom notice to the Polyglot front-end
  addNotice(key, text) {
    const newNotice = { [key]: text };
    const notices = Object.assign({}, this.getNotices(), newNotice);
    this.saveNotices(notices);
  }

  addNoticeTemp(key, text, delaySec) {
    const _this = this;

    // logger.info('Adding temp notice %s (%s)', key, delaySec);
    this.addNotice(key, text);

    // Waits delaySec, then delete the notice
    setTimeout(function() {
      // logger.info('Removing temp notice %s', key);
      _this.removeNotice(key);
    }, delaySec * 1000);
  }

  // Remove custom notice to the Polyglot front-end.
  // If there are multiple notices with the same text, they are all removed.
  removeNotice(key) {
    if (this.noticeExists(key)) {
      const notices = Object.assign({}, this.getNotices());
      delete notices[key];
      this.saveNotices(notices);
    }
  }

  // Remove all notices from the Polyglot front-end.
  removeNoticesAll() {
    this.saveNotices({});
  }

  // Get custom params (Keeps the existing params)
  getCustomParam(key) {
    if (typeof key !== 'string') {
      logger.error('getCustomParam error: Parameter is not a string.');
    } else {
      const params = this.getCustomParams();

      if (key in params) {
        return params[key];
      } else {
        logger.error('getCustomParam error: Parameter does not exist.');
      }
    }
  }

  // Get existing params from last config received
  getCustomParams() {
    return this._config.customParams;
  }

  // Sets the custom parameters to params (Will overwrite existing params)
  saveCustomParams(params) {
    if (typeof params !== 'object') {
      logger.error('saveCustomParams error: Parameter is not an object.');
    } else {
      const message = { customparams: params };
      this.sendMessage(message);
    }
  }

  // Add custom params (Keeps the existing params)
  addCustomParams(params) {
    if (typeof params !== 'object') {
      logger.error('addCustomParams error: Parameter is not an object.');
    } else {
      this.saveCustomParams(Object.assign(this.getCustomParams(), params));
    }
  }

  // Remove custom params (Keeps the existing params)
  removeCustomParams(key) {
    if (typeof key !== 'string') {
      logger.error('removeCustomParams error: Parameter is not a string.');
    } else {
      let params = this.getCustomParams();
      if (key in params) {
        delete params[key];
        this.saveCustomParams(params);
      }
    }
  }

  // Get whole custom data, or specific key if specified.
  // Comes from last config received
  getCustomData(key = null) {
    return key ? this._config.customData[key] : this._config.customData;
  }

  // Sets the custom data to data (Will overwrite existing custom data)
  saveCustomData(data) {
    if (typeof data !== 'object') {
      logger.error('saveCustomData error: Parameter is not an object');
    } else {
      // Also set the local copy so that it is readily available
      this._config.customData = data;

      const message = {customdata: data};
      this.sendMessage(message);
    }
  }

  // Add custom data (Keeps the existing data)
  addCustomData(data) {
    if (typeof data !== 'object') {
      logger.error('addCustomData error: Parameter is not an object.');
    } else {
      this.saveCustomData(Object.assign({}, this.getCustomData(), data));
    }
  }

  // Remove specified custom data (Keeps the remaining data)
  removeCustomData(key) {
    if (typeof key !== 'string') {
      logger.error('removeCustomData error: Parameter is not a string.');
    } else {
      let data = this.getCustomData();

      if (key in data) {
        delete data[key];
        this.saveCustomData(data);
      }
    }
  }

  // Start sending log data to the UI (+ Historical data)
  // _startLogStream(clientId) {
  //   const _this = this;
  //
  //   // Find items logged between today and yesterday, max 1000 entries
  //   const logQueryOptions = {
  //     from: new Date() - (24 * 60 * 60 * 1000), // Max 24hr back in time
  //     until: new Date(),
  //     start: 0,
  //     limit: 100, // Max 100 entries
  //     order: 'desc', // From most recent to oldest
  //   };
  //
  //   // First get historical data
  //   logger.jsonFileTransport.query(logQueryOptions, function(err, results) {
  //
  //     if (err) {
  //       logger.error('Error retrieving logs: %s', err.message);
  //     } else {
  //
  //       const historical = results.map(function(info) {
  //         return JSON.stringify(_this._mqttLogMapper(info));
  //       })
  //       .reverse()
  //       .join('\n');
  //
  //       zlib.deflate(historical, function(err, buffer) {
  //         if (!err) {
  //           // We send the raw buffer directly (byte array)
  //           _this._mqttClient.publish(_this._logTopic + '/file', buffer);
  //         } else {
  //           logger.error('Error deflating log data');
  //         }
  //       });
  //     }
  //
  //     // Add this clientId for logging
  //     _this._mqttLogObservers[clientId] = true;
  //
  //     // Make sure we send log events to MQTT
  //     logger.enableMqttLogging(_this._mqttTransport);
  //   });
  // }

  // _stopLogStream(clientId) {
  //   // Remove this clientId from logging
  //   delete this._mqttLogObservers[clientId];
  //
  //   if (!Object.keys(this._mqttLogObservers).length) {
  //     // Stop sending events to MQTT if we no longer have a client connected.
  //     logger.disableMqttLogging(this._mqttTransport);
  //   }
  // }

  // Send a command to Polyglot to restart this NodeServer
  restart() {
    logger.warn('Telling Polyglot to restart this node server.');
    this.sendMessage({restart: {}});
  }

  // ========= NOT YET SUPPORTED IN PGC =============

  // Sets the custom parameters to params
  saveTypedParams() {
    logger.error('saveTypedParams: This is not supported.');
  }

  // Sets the customParams documentation shown in the UI
  setCustomParamsDoc() {
    logger.error('setCustomParamsDoc: This is not supported.');
  }
};
