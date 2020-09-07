# Change Log

v1.0.13 (2020-09-07)
* Interface: Fixed primary node address

v1.0.12 (2020-03-29)
* Interface: Added updateProfileIfNew

v1.0.11 (2019-08-11)
* Interface: Handling of requestId

v1.0.8 (2019-06-27)
* Interface: logger has been simplified. PGC now uses stdout only.

v1.0.7 (2019-06-02)
* Interface: reportDrivers now only updates changed properties by default

v1.0.6 (2019-05-27)
* Interface: Fix to saveCustomParams
* Interface: Send disconnect status when stopping

v1.0.5 (2019-05-26)
* Node: Added method reportCmd(). This is used to initiate a command (such as DON) from the Nodeserver.

v1.0.4 (2019-05-18)
* Interface: Added getStage method, which tells us if we are running in test or production

v1.0.3 (2019-04-07)

* Interface: Added method getConfig().
* Interface: Added method addNoticeTemp(key, text, delaySec).
* The config object now has a newParamsDetected flag which tells us if customParams changed.
* Fixed logger.errorStack()
* Node.setDriver() converts values to string, as expected by PGC
