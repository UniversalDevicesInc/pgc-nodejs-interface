# UDI Polyglot Cloud Interface Module (Node.js)

This is the Polyglot interface API module that is used to develop a node.js based NodeServer for Polyglot Cloud (PGC).

## Installation

pgc-nodejs-interface attempts to maintain feature parity with poly-nodejs-interface (the on-prem Polyglot interface API module for Node.js) anything you can do there you should be able to do in the cloud.

Caveats:

* No custom config docs
* No typed params

## Starting your NodeServer build

When you start building a NodeServer you are helping build the free and open Internet of Things. Thank you! If you run in to any issues please ask your questions on the [UDI Polyglot Forums](http://forum.universal-devices.com/forum/111-polyglot/).

To get started, use the [node.js NodeServer template](https://github.com/UniversalDevicesInc/poly-template-nodejs).
This is a simple but fully functional NodeServer.

One of the first things you will want to do is to create your profile files. See the profile folder from the NodeServer
template for an example. Please refer to the [ISY Version 5 API](https://wiki.universal-devices.com/index.php?title=ISY_Developers:API:V5) to learn how to create your profile files.

The polyglot interface module has 2 main javascript classes you need to use to interact with Polyglot.

### The Node class
The Node class represents a generic ISY node. Your custom nodes will have to inherit from this class, and they should
match the status and the controls that you have created in your nodedefs.

```javascript
const Polyglot = require('pgc_interface');

module.exports = class MyNode extends Polyglot.Node {

  // polyInterface: handle to the interface
  // address: Your node address, without the leading 'n999_'
  // primary: Same as address, if the node is a primary node
  // name: Your node name

  constructor(polyInterface, primary, address, name) {
    super(nodeDefId, polyInterface, primary, address, name);

    // Commands that this node can handle.
    // Should match the 'accepts' section of the nodedef.
    this.commands = {
      DON: this.onDON,
      DOF: this.onDOF,
      QUERY: this.onQuery,
    };

    // Status that this node has.
    // Should match the 'sts' section of the nodedef.
    this.drivers = {
      ST: {value: 0, uom: 51},
    };
  }

  onDON(message) {
    logger.info('DON (%s): %s',
      this.address,
      message.value ? message.value : 'No value');

    // setDrivers accepts string or number (message.value is a string
    this.setDriver('ST', message.value ? message.value : 100);
  }

  onDOF() {
    logger.info('DOF (%s)', this.address);

    this.setDriver('ST', 0);
  }
};
```


##### The Node class has these standard properties

`this.id` (This is the Nodedef ID)

`this.polyInterface` (Gives access to the Polyglot interface)

`this.primary` (Primary address)

`this.address` (Node address)

`this.name` (Node name)

`this.timeAdded` (Time added)

`this.enabled` (Node is enabled?)

`this.added` (Node is added to ISY?)

`this.commands` (List of commands)

`this.drivers` (List of drivers)

The list of commands in your custom node need to map to a function which is executed when the command command is
triggered.

The list of drivers defines the node statuses, the uom, and contains the value.


##### The Node class has these standard methods

this.getDriver(driver), to get the driver object.

this.setDriver(driver, value, report=true, forceReport=false, uom=null), to set a driver to a value
(example set ST to 100).

this.reportDriver(driver, forceReport), to send existing driver value to ISY.

this.reportDrivers(), To send existing driver values to ISY.

this.reportCmd(), To run a command on this node on ISY. (Example DON)

this.query(), which is called when we get a query request (Override this to fetch live data).

this.status(), which is called when we get a status request for this node.

this.delNode(), which will remove the node from Polyglot and the ISY.

##### The controller node

Normally, your NodeServer should have a controller node, in addition to your custom nodes. The controller node is
a regular ISY node which holds the status of your NodeServer (Is it active or not?), and can also provide commands
to interact with the NodeServer from the admin console or an ISY program.

Please see the template for a complete example of a custom node and a controller node.

### The Interface class
The Interface class is a singleton used to interact with Polyglot through MQTT.

You first need to instantiate the interface by passing an array of node definitions that you have created.
Once instantiated, you can use events triggered by the interface such as `config`, `poll` or `stop`.

```javascript
const Polyglot = require('polyinterface');
const ControllerNode = require('./Nodes/ControllerNode.js'); // Controller node
const MyNode = require('./Nodes/MyNode.js'); // This is an example node


// Create an instance of the Polyglot interface. We need pass in parameter all
// the Node classes that we will be using.
const poly = new Polyglot.Interface([ControllerNode, MyNode]);

// Config has been received
poly.on('config', function(config) {
  const nodesCount = Object.keys(config.nodes).length;

  logger.info('Config received has %d nodes', nodesCount);

  if (config.isInitialConfig) {
    logger.info('This is the first config received after the NodeServer restart');
  }
});

// This is triggered every x seconds. Frequency is configured in the UI.
poly.on('poll', function(longPoll) {
  logger.info('%s', longPoll ? 'Long poll' : 'Short poll');
});

// Received a 'stop' message from Polyglot. This NodeServer is shutting down
poly.on('stop', function() {
  logger.info('Graceful stop');
});

// Starts the NodeServer!
poly.start();
```

##### The Interface class events

`config` is triggered whenever there is a change in the configuration, the nodes, the notices, anything. The config
is passed in parameter. You can check for config.isInitialConfig to know if the is the first config received. Use this
for initialization when you want to have a working config loaded.

The config object will have a property newParamsDetected set to true if the customParams changed.

`poll` is triggered frequently, based on your short poll and long poll values. The longPoll parameter is a flag telling
you if this is a long poll or short poll.

`stop` is triggered whenever the node server is being stopped.

`delete` is triggered whenever the user is deleting the NodeServer.


The following events are less commonly used but could be useful for troubleshooting:

`messageReceived` is triggered for every messages received from Polyglot to the NodeServer.

`messageSent` is triggered for every messages sent to Polyglot from your NodeServer.

`mqttConnected` is the first event being triggered and happens when the MQTT connection is established. The config is
not yet available.

`mqttReconnect` the MQTT connection reconnected.

`mqttOffline` the MQTT connection went offline.

`mqttClose` the MQTT connection closed.

`mqttEnd` the MQTT connection ended.

`oauth` is triggered when the user has linked your Nodeserver. 
[Click here for more information on using oAuth](#Using-OAuth) with your Nodeserver.

##### The Interface class methods

start(), to initiate the MQTT connection and start communicating with Polyglot.

stop(), will do a last short poll and long poll, then terminate the MQTT connection and stop.

isConnected(), which tells you if this NodeServer is connected via MQTT.

async addNode(node), which adds a new node to Polyglot. You fist need to instantiate a node using your custom class,
which you then pass to addNode. This is an async function which allows you to "await" the result and verify if the
addNode was successful.

getStage(), Returns either 'test' or 'prod', whether we are running on pgtest.isy.io or polyglot.isy.io. This is the STAGE environment variable.

getConfig(), Returns a copy of the last config received.

getNodes(), gives you your list of nodes. This is not just an array of nodes returned by Polyglot. This is a list of
nodes with your classes applied to them.

getNode(address), gives you a single node.

delNode(node), allows you to delete the node specified. You need to pass the actual node. Alternatively, you can use
delNode() directly on the node itself, which has the same effect.

updateProfile(), sends the latest profile to ISY from the profile folder.

getNotices(), gives you the current list of Polyglot notices.

addNotice(key, text), adds a notice to the Polyglot UI. The key allows to refer to that notice later on.

addNoticeTemp(key, text, delaySec), adds a notice to the Polyglot UI. The notice will be active for delaySec seconds.

removeNotice(key), remove notice specified by the key.

removeNoticesAll(), removes all notices from Polyglot.

getCustomParams(), gives you all the configuration parameters from the UI.

getCustomParam(key), Gives you the param as seen in the UI.

saveCustomParams(params), Saves the params as specified by the params objects. All the params not passed here will be lost.

addCustomParams(params), Adds custom params specified by the params objects. This will be added to the existing params.

removeCustomParams(key), Removed the custom param specified by the key.

saveTypedParams(typedParams), *** This is not available on PGC ***.

setCustomParamsDoc(html), *** This is not available on PGC ***.

saveCustomData(data), allows you to save data for your node server. This will overwrite the existing data.

addCustomData(data), allows you to save data for your node server. This will add to your existing data, as long as the keys are different.

getCustomData(key = null), gives you all of your custom data, or a specific key if specified.

removeCustomData(key), allows you to delete custom data.

restart(), allows you to self restart the NodeServer.


### Creating nodes

Nodes are created by instantiating one of your node classes, and using the addNode method on the interface:

```javascript
const createdNode = new MyNode(this.polyInterface, primaryAddress, nodeAddress, nodeDescription)
this.polyInterface.addNode(createdNode);
```

You could do this different ways;

If your node server has a fixed set of nodes, you can perhaps create them within the config event. If the expected
nodes are not there, you could create them there on startup.

You could as well create them during polling, as you discover them from a third party API.

Perhaps they could also be defined using the configuration UI, using the typedParams list option.

In the Template, they are created using a command from the controller Node. This allows to create new nodes using an
admin console button.


### Logger

This polyglot interface uses a logging mecanism that you can also use in your NodesServer.

```javascript
const logger = Polyglot.logger;

logger.debug('Debugging');
logger.info('Info with more informations: %s', myInformation);
logger.warn('Warning with perhaps an object logged: %o', myObject);
logger.error('Error...');

// For unexpected errors, it may be wise to use errorStack to log an error with the stack information:
try {
  thisThrowsAnError()
} catch(err) {
  // Notice the err object as the first parameter. The message is added to the end.
  logger.errorStack(err, 'Error with stack information:');
}
```

## Cloud Methods and API's

### Using OAuth

For more information on using OAuth with your Nodeserver, [please see these instructions](https://github.com/UniversalDevicesInc/pgc-python-interface/blob/master/README.md#additional-cloud-methods-and-apis).


## Testing your Nodeserver

We have created the ability to locally run your NodeServer on the 
development platform. This gives you the ability to test and make sure 
everything is working properly before asking us to release it.
[Please see these instructions](https://github.com/UniversalDevicesInc/pgc-python-interface/blob/master/README.md#testing-your-nodeserver). 

