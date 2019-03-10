'use strict';

const winston = require('winston'); // Logging framework
const Transport = require('winston-transport'); // For custom transport

require('winston-daily-rotate-file');
const format = winston.format;

function zPad2(str) {
  return str.toString().padStart(2, '0');
}

// Used for the ./logs/<logfile> and the console
const logFormatter = format.combine(
  format.splat(),
  format.timestamp(),
  winston.format.printf(info => {
    const d = new Date(info.timestamp);
    const dStr = d.getFullYear() + '-' +
      zPad2(d.getMonth() + 1) + '-' +
      zPad2(d.getDate()) + ' ' +
      zPad2(d.getHours()) + ':' +
      zPad2(d.getMinutes()) + ':' +
      zPad2(d.getSeconds());

    return `${dStr} ${info.level}: ${info.label}: ${info.message}`;
  })
);

// Used for the ./logs.json/<logfile> as well as the MQTT transport
const jsonlogFormatter = format.combine(
  format.timestamp(), // Adds a timestamp property
  format.splat(), // Formats the message with util.format
  format.json() // Returns a JSON object
);

const fileTransport = new (winston.transports.DailyRotateFile)({
  handleExceptions: true,
  filename: './logs/%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '10m',
  maxFiles: '7d',
  level: 'debug',
  format: logFormatter,
});

const jsonFileTransport = new (winston.transports.DailyRotateFile)({
  handleExceptions: true,
  filename: './logs.json/%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '2m',
  maxFiles: '2d',
  level: 'debug',
  json: true,
  format: jsonlogFormatter,
});

const consoleTransport = new (winston.transports.Console)({
  handleExceptions: true,
  level: 'debug',
  format: logFormatter,
});

let transports = [ jsonFileTransport, fileTransport ];

// Add local logging if we are in development
if (process.env.STAGE === 'test') {
  transports.push(consoleTransport);
}

// PGC interface specific logger
winston.loggers.add('pgc', {
  format: format.label({label: 'PGC'}),
  exitOnError: true,
  transports: transports,
});

// Custom node server specific logger. Will have NS: in the messages
winston.loggers.add('ns', {
  format: format.label({label: 'NS'}),
  exitOnError: true,
  transports: transports,
});

// --------
// EXPORTS
// --------

// This is the main logger for pgc interface
module.exports = winston.loggers.get('pgc');

// This is the logger for the nodeserver. The message will have label='ns'
module.exports.ns = winston.loggers.get('ns');

// Usage: logger.errorStack(err, 'whatever %s:', variable)
module.exports.errorStack = function(err) {
  // Remove first argument
  const loggerArgs = Array.prototype.slice.call(arguments, 1);

  if (err instanceof Error) {
    loggerArgs[0] += ' ' + err.stack;
  } else {
    loggerArgs[0] += ' ' + err; // Example: throw 'abc_string'
  }

  module.exports.error.apply(this, loggerArgs);
};

// -----------------------------------------------
// MQTT Transport class to show log in the Polyglot UI
// Inherit from `winston-transport` so you can take advantage
// of the base functionality and `.exceptions.handle()`.
// It is instantiated in the Interface, and passed to enable/disableMqttLogging
module.exports.MqttTransport = class mqttTransport extends Transport {
  constructor(opts) {
    super(opts);
    this.mqttHandler = opts.mqttHandler; // Set when instantiated
    this.format = jsonlogFormatter;
  }

  log(info, callback) {
    const _this = this;
    setImmediate(() => {
      if (_this.mqttHandler) {
        _this.mqttHandler(info);
      }
      this.emit('logged', info);
    });

    callback(); // Logging finished
  }
};

// Enable the MQTT Transport
// mqttTransport is instantiated in Interface from the class above
module.exports.enableMqttLogging = function(mqttTransport) {
  module.exports.add(mqttTransport);
  module.exports.ns.add(mqttTransport);
};

// Disable the MQTT Transport
module.exports.disableMqttLogging = function(mqttTransport) {
  module.exports.remove(mqttTransport);
  module.exports.ns.remove(mqttTransport);
};

// Allows to query the logs
module.exports.jsonFileTransport = jsonFileTransport;
