/*
 * coreBroker class
 */
import pidUsage from 'pidusage';

import { IMqttServer } from './imports.js';

// ping -> ack: the port is alive
function _izPing( self, reply ){
    reply.answer = 'iz.ack';
    return Promise.resolve( reply );
}

// returns the full status of the server
function _izStatus( self, reply ){
    return self.status()
        .then(( status ) => {
            reply.answer = status;
            return Promise.resolve( reply );
        });
}

// terminate the server and its relatives (broker, managed, plugins)
function _izStop( self, reply ){
    self.terminate( reply.args, ( res ) => {
        reply.answer = res;
        self.api().exports().Msg.debug( 'coreBroker.izStop()', 'replying with', reply );
        return Promise.resolve( reply );
    });
}

export class coreBroker {

    /**
     * Default ports number
     */
     static d = {
        listenPort: 24002,
        messagingPort: 24003
    };

    /**
     * The commands which can be received by the coreController via the TCP communication port
     * - keys are the commands
     *   > label {string} a short help message
     *   > fn {Function} the execution function (cf. above)
     *   > endConnection {Boolean} whether the server should close the client connection
     *      alternative being to wait for the client closes itself its own connection
     */
     static c = {
        'iz.ping': {
            label: 'ping the service',
            fn: _izPing,
            endConnection: false
        },
        'iz.status': {
            label: 'returns the status of this coreBroker service',
            fn: _izStatus,
            endConnection: false
        },
        'iz.stop': {
            label: 'stop this coreBroker service',
            fn: _izStop,
            endConnection: true
        }
    };

    // runtime configuration
    _tcpPort = 0;
    _messagingPort = null;

    // when stopping, the port to which answer and forward the received messages
    _forwardPort = 0;

    /**
     * @param {coreApi} api the core API as described in core-api.schema.json
     * @returns {coreBroker}
     */
    constructor( api ){
        const exports = api.exports();
        const Interface = exports.Interface;
        const Msg = exports.Msg;

        Interface.extends( this, exports.baseService, api );
        Msg.debug( 'coreBroker instanciation' );

        this.api( api );

        Interface.add( this, exports.IForkable, {
            _terminate: this.iforkableTerminate
        });

        Interface.add( this, exports.IMqttClient, {
            _class: this._class,
            _module: this.module,
            _name: this.name
        });

        Interface.add( this, exports.IRunFile, {
            runDir: this.irunfileRunDir
        });

        Interface.add( this, exports.IServiceable, {
            class: this._class,
            cleanupAfterKill: this.iserviceableCleanupAfterKill,
            getCheckStatus: this.iserviceableGetCheckStatus,
            helloMessage: this.iserviceableHelloMessage,
            start: this.iserviceableStart,
            status: this.iserviceableStatus,
            stop: this.iserviceableStop
        });

        Interface.add( this, exports.ITcpServer, {
            _execute: this.itcpserverExecute,
            _listening: this.itcpserverListening,
            _statsUpdated: this.itcpserverStatsUpdated
        });

        Interface.add( this, IMqttServer, {
            _api: this.api
        });

        // must be determined at construction time to be available when initializing IServiceable instance
        this._tcpPort = api.serviceConfig().listenPort || coreBroker.d.listenPort;
        this._messagingPort = api.serviceConfig().messagingPort || coreBroker.d.messagingPort;

        return this;
    }

    _class(){
        return this.constructor.name;
    }

    /*
     * Terminates the child process
     * @returns {Promise} which resolves when the process is actually about to terminate (only waiting for this Promise)
     * [-implementation Api-]
     */
    iforkableTerminate(){
        this.api().exports().Msg.debug( 'coreBroker.iforkableTerminate()' );
        return this.terminate();
    }

    /*
     * @returns {String} the full pathname of the run directory
     * [-implementation Api-]
     */
    irunfileRunDir(){
        this.api().exports().Msg.debug( 'coreBroker.irunfileRunDir()' );
        return this.api().coreConfig().runDir();
    }

    /*
     * If the service had to be SIGKILL'ed to be stoppped, then gives it an opportunity to make some cleanup
     * [-implementation Api-]
     */
    iserviceableCleanupAfterKill(){
        this.api().exports().Msg.debug( 'coreBroker.iserviceableCleanupAfterKill()' );
        this.IRunFile.remove( this.api().service().name());
    }

    /*
     * @returns {Promise} which must resolve to an object conform to check-status.schema.json
     * [-implementation Api-]
     */
    iserviceableGetCheckStatus(){
        this.api().exports().Msg.debug( 'coreBroker.iserviceableGetCheckStatus()' );
        const _name = this.api().service().name();
        const _json = this.IRunFile.jsonByName( _name );
        let o = { startable: false, reasons: [], pids: [], ports: [] };
        if( _json && _json[_name] ){
            o.pids = [ ... _json[_name].pids ];
            o.ports = [ _json[_name].listenPort ];
            o.startable = o.pids.length === 0 && o.ports.length === 0;
        } else {
            o.startable = true;
        }
        this.api().exports().Msg.debug( 'coreBroker.iserviceableGetCheckStatus() resolves with', o );
        return Promise.resolve( o );
    }

    /*
     * @returns {String} the helloMessage from the runfile (if any)
     * [-implementation Api-]
     */
    iserviceableHelloMessage(){
        const _name = this.api().service().name();
        const _json = this.IRunFile.jsonByName( _name );
        if( _json && _json[_name].helloMessage ){
            return _json[_name].helloMessage;
        }
        return null;
    }

    /*
     * @returns {Promise}
     * [-implementation Api-]
     */
    iserviceableStart(){
        const exports = this.api().exports();
        const Msg = exports.Msg;
        Msg.debug( 'coreBroker.iserviceableStart()', 'forkedProcess='+exports.IForkable.forkedProcess());
        return Promise.resolve( true )
            .then(() => { return this.ITcpServer.create( this._tcpPort ); })
            .then(() => { Msg.debug( 'coreBroker.iserviceableStart() tcpServer created' ); })
            .then(() => { return this.IMqttServer.create( this._messagingPort ); })
            .then(() => { Msg.debug( 'coreBroker.iserviceableStart() mqttServer created' ); })
            .then(() => { this.IMqttClient.advertise({ port:this._messagingPort, reconnectPeriod:5*1000 }); })
            .then(() => { return new Promise(() => {}); });
    }

    /*
     * Get the status of the service
     * @returns {Promise} which resolves the a status object
     * [-implementation Api-]
     */
    iserviceableStatus(){
        this.api().exports().Msg.debug( 'coreBroker.iserviceableStatus()' );
        this.api().exports().utils.tcpRequest( this._tcpPort, 'iz.status' )
            .then(( answer ) => {
                this.api().exports().Msg.debug( 'coreBroker.iserviceableStatus()', 'receives answer to \'iz.status\'', answer );
            }, ( failure ) => {
                // an error message is already sent by the called self.api().exports().utils.tcpRequest()
                //  what more to do ??
                //Msg.error( 'TCP error on iz.stop command:', failure );
            });
    }

    /*
     * @returns {Promise}
     * [-implementation Api-]
     */
    iserviceableStop(){
        this.api().exports().Msg.debug( 'coreBroker.iserviceableStop()' );
        this.api().exports().utils.tcpRequest( this._tcpPort, 'iz.stop' )
            .then(( answer ) => {
                this.api().exports().Msg.debug( 'coreBroker.iserviceableStop()', 'receives answer to \'iz.stop\'', answer );
            }, ( failure ) => {
                // an error message is already sent by the called self.api().exports().utils.tcpRequest()
                //  what more to do ??
                //IMsg.error( 'TCP error on iz.stop command:', failure );
            });
    }

    /*
     * Execute a received commands and replies with an answer
     * @param {String[]} words the received command and its arguments
     * @param {Object} client the client connection
     * @returns {Boolean} true if we knew the command and (at least tried) execute it
     * [-implementation Api-]
     */
    itcpserverExecute( words, client ){
        const self = this;
        let reply = this.ITcpServer.findExecuter( words, coreBroker.c );
        //console.log( reply );
        if( reply ){
            reply.obj.fn( this, reply.answer )
                .then(( result ) => {
                    self.ITcpServer.answer( client, result, reply.obj.endConnection );
                });
        }
        return reply;
    }

    /*
     * What to do when this ITcpServer is ready listening ?
     *  -> write the runfile before advertising parent to prevent a race condition when writing the file
     *  -> send the current service status
     * [-implementation Api-]
     */
    itcpserverListening(){
        this.api().exports().Msg.debug( 'coreBroker.itcpserverListening()' );
        const self = this;
        const _name = this.api().service().name();
        let _msg = 'Hello, I am \''+_name+'\' '+this.constructor.name;
        _msg += ', running with pid '+process.pid+ ', listening on port '+this._tcpPort;
        this.status().then(( status ) => {
            status[_name].event = 'startup';
            status[_name].helloMessage = _msg;
            status[_name].status = this.ITcpServer.status().status;
            self.IRunFile.set( _name, status );
            self.IForkable.advertiseParent( status );
        });
    }

    /*
     * Internal stats have been modified
     * [-implementation Api-]
     */
    itcpserverStatsUpdated(){
        this.api().exports().Msg.debug( 'coreBroker.itcpserverStatsUpdated()' );
        const _name = this.api().service().name();
        const _status = this.ITcpServer.status();
        this.IRunFile.set([ _name, 'ITcpServer' ], _status );
    }

    /**
     * @returns {Promise} which resolves to a status Object
     * Note:
     *  The object returned by this function (aka the 'status' object) is used not only as the answer
     *  to any 'iz.status' TCP request, but also:
     *  - at startup, when advertising the main process, to display the startup message on the console
     *  - after startup, to write into the IRunFile.
     *  A minimum of structure is so required, described in run-status.schema.json.
     */
    status(){
        const _serviceName = this.name();
        this.api().exports().Msg.debug( 'coreBroker.status()', 'serviceName='+_serviceName );
        const self = this;
        let status = {};
        status[_serviceName] = {};
        // ITcpServer
        const _tcpServerPromise = function(){
            return new Promise(( resolve, reject ) => {
                const o = self.ITcpServer.status();
                self.api().exports().Msg.debug( 'coreBroker.status()', 'ITcpServer', o );
                status[_serviceName].ITcpServer = { ...o };
                resolve( status );
            });
        };
        // run-status.schema.json
        const _runStatus = function(){
            return new Promise(( resolve, reject ) => {
                const o = {
                    module: self.module(),
                    class: self._class(),
                    pids: [ process.pid ],
                    ports: [ self._tcpPort, self._messagingPort ],
                    status: status[_serviceName].ITcpServer.status
                };
                self.api().exports().Msg.debug( 'coreBroker.status()', 'runStatus', o );
                status[_serviceName] = { ...status[_serviceName], ...o };
                resolve( status );
            });
        };
        // coreBroker
        const _thisStatus = function(){
            return new Promise(( resolve, reject ) => {
                const o = {
                    listenPort: self._tcpPort,
                    messagingPort: self._messagingPort,
                    // running environment
                    environment: {
                        IZTIAR_DEBUG: process.env.IZTIAR_DEBUG || '(undefined)',
                        IZTIAR_ENV: process.env.IZTIAR_ENV || '(undefined)',
                        NODE_ENV: process.env.NODE_ENV || '(undefined)'
                    },
                    // general runtime constants
                    logfile: self.api().exports().Logger.logFname(),
                    runfile: self.IRunFile.runFile( _serviceName ),
                    storageDir: self.api().exports().coreConfig.storageDir(),
                    version: self.api().corePackage().getVersion()
                };
                self.api().exports().Msg.debug( 'coreBroker.status()', 'brokerStatus', o );
                status[_serviceName] = { ...status[_serviceName], ...o };
                resolve( status );
            });
        };
        // pidUsage
        const _pidPromise = function( firstRes ){
            return new Promise(( resolve, reject ) => {
                pidUsage( process.pid )
                    .then(( pidRes ) => {
                        const o = {
                            cpu: pidRes.cpu,
                            memory: pidRes.memory,
                            ctime: pidRes.ctime,
                            elapsed: pidRes.elapsed
                        };
                        self.api().exports().Msg.debug( 'coreBroker.status()', 'pidUsage', o );
                        status[_serviceName].pidUsage = { ...o };
                        resolve( status );
                    });
            });
        };
        return Promise.resolve( true )
            .then(() => { return _tcpServerPromise(); })
            .then(() => { return _runStatus(); })
            .then(() => { return _thisStatus(); })
            .then(() => { return _pidPromise(); });
    }

    /**
     * terminate the server
     * Does its best to advertise the main process of what it will do
     * (but be conscious that it will also close the connection rather soon)
     * @param {string[]|null} args the parameters transmitted after the 'iz.stop' command
     * @param {Callback} cb the function to be called back to acknowledge the request
     * @returns {Promise} which resolves when the server is terminated
     * Note:
     *  Receiving 'iz.stop' command calls this terminate() function, which has the side effect of.. terminating!
     *  Which sends a SIGTERM signal to this process, and so triggers the signal handler, which itself re-calls
     *  this terminate() function. So, try to prevent a double execution.
     */
    terminate( words=[], cb=null ){
        this.api().exports().Msg.debug( 'coreBroker.terminate()' );
        const _status = this.ITcpServer.status();
        if( _status.status === this.api().exports().ITcpServer.s.STOPPING ){
            Msg.debug( 'coreBroker.terminate() returning as currently stopping' );
            return Promise.resolve( true );
        }
        if( _status.status === this.api().exports().ITcpServer.s.STOPPED ){
            Msg.debug( 'coreBroker.terminate() returning as already stopped' );
            return Promise.resolve( true );
        }
        const _name = this.name();
        const _module = this.module();
        this._forwardPort = words && words[0] && self.api().exports().utils.isInt( words[0] ) ? words[0] : 0;

        const self = this;

        // closing the TCP server
        //  in order the TCP server be closeable, the current connection has to be ended itself
        //  which is done by the promise
        let _promise = Promise.resolve( true )
            .then(() => {
                if( cb && typeof cb === 'function' ){
                    cb({ name:_name, module:_module, class:self._name(), pid:process.pid, port:self._tcpPort });
                }
                return self.ITcpServer.terminate();
            })
            .then(() => {
                // we auto-remove from runfile as late as possible
                //  (rationale: no more runfile implies that the service is no more testable and expected to be startable)
                self.IMqttClient.terminate();
                self.IRunFile.remove( _name );
                this.api().exports().Msg.info( _name+' coreBroker terminating with code '+process.exitCode );
                return Promise.resolve( true)
                //process.exit();
            });

        return _promise;
    }
}
