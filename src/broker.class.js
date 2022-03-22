/*
 * coreBroker class
 */
import pidUsage from 'pidusage';

import { IMqttServer } from './imports.js';

export class coreBroker {

    /**
     * Default ports number
     */
    static d = {
        listenPort: 24002
    };

    /**
     * The commands which can be received by the coreController via the TCP communication port
     * - keys are the commands
     *   > label {string} a short help message
     *   > fn {Function} the execution function (cf. above)
     *   > endConnection {Boolean} whether the server should close the client connection
     *      alternative being to wait for the client closes itself its own connection
     */
    static verbs = {
        'iz.status': {
            label: 'return the status of this coreBroker service',
            fn: coreBroker._izStatus
        },
        'iz.stop': {
            label: 'stop this coreBroker service',
            fn: coreBroker._izStop,
            end: true
        }
    };

    // returns the full status of the server
    static _izStatus( self, reply ){
        return self.publiableStatus()
            .then(( status ) => {
                reply.answer = status;
                return Promise.resolve( reply );
            });
    }

    // terminate the server and its relatives (broker, managed, plugins)
    static _izStop( self, reply ){
        self.terminate( reply.args, ( res ) => {
            reply.answer = res;
            self.IFeatureProvider.api().exports().Msg.debug( 'coreBroker.izStop()', 'replying with', reply );
            return Promise.resolve( reply );
        });
    }

    // when this feature has started
    _started = null;

    // when stopping, the port to which answer and forward the received messages
    _forwardPort = 0;

    /**
     * @param {engineApi} api the engine API as described in engine-api.schema.json
     * @param {featureCard} card a description of this feature
     * @returns {Promise} which resolves to a coreBroker instance
     */
    constructor( api, card ){
        const exports = api.exports();
        const Interface = exports.Interface;
        const Msg = exports.Msg;

        //Interface.extends( this, exports.baseService, api, card );
        Msg.debug( 'coreBroker instanciation' );
        let _promise = this.fillConfig( api, card );

        // must implement the IFeatureProvider
        Interface.add( this, exports.IFeatureProvider, {
            forkable: this.ifeatureproviderForkable,
            killed: this.ifeatureproviderKilled,
            start: this.ifeatureproviderStart,
            status: this.ifeatureproviderStatus,
            stop: this.ifeatureproviderStop
        });
        this.IFeatureProvider.api( api );
        this.IFeatureProvider.feature( card );
        _promise = _promise.then(() => { Interface.fillConfig( this, 'IFeatureProvider' ); });

        // add this rather sooner, so that other interfaces may take advantage of it
        Interface.add( this, exports.ICapability );

        this.ICapability.add(
            'checkableStatus', ( o ) => { return o.checkableStatus(); }
        );
        this.ICapability.add(
            'broker', ( o ) => { return Promise.resolve( o.IRunFile.get( card.name(), 'helloMessage' )); }
        );
        this.ICapability.add(
            'helloMessage', ( o, cap ) => { return Promise.resolve( o.IRunFile.get( card.name(), cap )); }
        );
        _promise = _promise.then(() => { Interface.fillConfig( this, 'ICapability' ); });

        Interface.add( this, exports.IForkable, {
            _terminate: this.iforkableTerminate
        });
        _promise = _promise.then(() => { Interface.fillConfig( this, 'IForkable' ); });

        // declare IMqttServer before IMqttClient because the former forces the presence of the later
        Interface.add( this, IMqttServer );
        _promise = _promise.then(() => { Interface.fillConfig( this, 'IMqttServer' ); });

        Interface.add( this, exports.IMqttClient, {
            _status: this._imqttclientStatus
        });
        _promise = _promise.then(() => { Interface.fillConfig( this, 'IMqttClient' ); });

        Interface.add( this, exports.IRunFile, {
            runDir: this.irunfileRunDir
        });
        _promise = _promise.then(() => { Interface.fillConfig( this, 'IRunFile' ); });

        Interface.add( this, exports.ITcpServer, {
            _listening: this.itcpserverListening,
            _verbs: this.itcpserverVerbs
        });
        _promise = _promise.then(() => { Interface.fillConfig( this, 'ITcpServer' ); });

        _promise = _promise.then(() => { return Promise.resolve( this ); });
        return _promise;
    }

    /*
     * @returns {Object} the filled configuration for the feature
     * [-implementation Api-]
     */
    ifeatureproviderConfig(){
        this.IFeatureProvider.api().exports().Msg.debug( 'coreBroker.ifeatureproviderConfig()', this.IFeatureProvider.feature().config());
        return this.IFeatureProvider.feature().config();
    }

    /*
     * @returns {Boolean} true if the process must be forked
     * [-implementation Api-]
     */
    ifeatureproviderForkable(){
        this.IFeatureProvider.api().exports().Msg.debug( 'coreBroker.ifeatureproviderForkable()' );
        return true;
    }

    /*
     * If the service had to be SIGKILL'ed to be stoppped, then gives it an opportunity to make some cleanup
     * [-implementation Api-]
     */
    ifeatureproviderKilled(){
        this.IFeatureProvider.api().exports().Msg.debug( 'coreBroker.ifeatureproviderKilled()' );
        this.IRunFile.remove( this.IFeatureProvider.feature().name());
    }

    /*
     * @param {String} name the name of the feature
     * @param {Callback|null} cb the funtion to be called on IPC messages reception (only relevant if a process is forked)
     * @param {String[]} args arguments list (only relevant if a process is forked)
     * @returns {Promise}
     *  - which never resolves in the forked process (server hosting) so never let the program exits
     *  - which resolves to the forked child process in the main process
     * [-implementation Api-]
     */
    ifeatureproviderStart( name, cb, args ){
        const exports = this.IFeatureProvider.api().exports();
        const _forked = exports.IForkable.forkedProcess();
        exports.Msg.debug( 'coreBroker.ifeatureproviderStart()', 'forkedProcess='+_forked );
        if( _forked ){
            const featCard = this.IFeatureProvider.feature();
            return Promise.resolve( true )
                .then(() => { return this.ITcpServer.create( featCard.config().ITcpServer.port ); })
                .then(() => { exports.Msg.debug( 'coreBroker.ifeatureproviderStart() tcpServer created' ); })
                .then(() => { return this.IMqttServer.create( featCard.config().IMqttServer.port ); })
                .then(() => { exports.Msg.debug( 'coreBroker.ifeatureproviderStart() mqttServer created' ); })
                .then(() => { this.IMqttClient.advertise( featCard.config().IMqttClient ); })
                .then(() => { return new Promise(() => {}); });
        } else {
            return Promise.resolve( exports.IForkable.fork( name, cb, args ));
        }
    }

    /*
     * Get the status of the service
     * @returns {Promise} which resolves to the status object
     * [-implementation Api-]
     */
    ifeatureproviderStatus(){
        const exports = this.IFeatureProvider.api().exports();
        exports.Msg.debug( 'coreBroker.ifeatureproviderStatus()' );
        exports.utils.tcpRequest( this.IFeatureProvider.feature().config().ITcpServer.port, 'iz.status' )
            .then(( answer ) => {
                exports.Msg.debug( 'coreBroker.ifeatureproviderStatus()', 'receives answer to \'iz.status\'', answer );
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
    ifeatureproviderStop(){
        const exports = this.IFeatureProvider.api().exports();
        exports.Msg.debug( 'coreBroker.ifeatureproviderStop()' );
        exports.utils.tcpRequest( this.IFeatureProvider.feature().config().ITcpServer.port, 'iz.stop' )
            .then(( answer ) => {
                exports.Msg.debug( 'coreBroker.ifeatureproviderStop()', 'receives answer to \'iz.stop\'', answer );
            }, ( failure ) => {
                // an error message is already sent by the called self.api().exports().utils.tcpRequest()
                //  what more to do ??
                //IMsg.error( 'TCP error on iz.stop command:', failure );
            });
    }

    /*
     * Terminates the child process
     * @returns {Promise} which resolves when the process is actually about to terminate (only waiting for this Promise)
     * [-implementation Api-]
     */
    iforkableTerminate(){
        this.IFeatureProvider.api().exports().Msg.debug( 'coreBroker.iforkableTerminate()' );
        return this.terminate();
    }

    /**
     * @returns {Promise} which resolves to the status of the service
     * we want here remove the first key because it is useless as part of the topic
     * [-implementation Api-]
     */
    _imqttclientStatus(){
        return this.publiableStatus().then(( res ) => {
            const name = Object.keys( res )[0];
            return res[name];
        });
    }

    /*
     * @returns {String} the full pathname of the run directory
     * [-implementation Api-]
     */
    irunfileRunDir(){
        this.IFeatureProvider.api().exports().Msg.debug( 'coreBroker.irunfileRunDir()' );
        return this.IFeatureProvider.api().config().runDir();
    }

    /*
     * What to do when this ITcpServer is ready listening ?
     *  -> write the runfile before advertising parent to prevent a race condition when writing the file
     *  -> send the current service status
     * @param {Object} tcpServerStatus
     * [-implementation Api-]
     */
    itcpserverListening( tcpServerStatus ){
        const exports = this.IFeatureProvider.api().exports();
        exports.Msg.debug( 'coreBroker.itcpserverListening()' );
        const featCard = this.IFeatureProvider.feature();
        const _name = featCard.name();
        const _port = featCard.config().ITcpServer.port;
        let _msg = 'Hello, I am \''+_name+'\' '+featCard.class();
        _msg += ', running with pid '+process.pid+ ', listening on port '+_port;
        let st = new exports.Checkable();
        st.pids = [ process.pid ];
        st.ports = [ _port ];
        let status = {};
        status[_name] = {
            module: featCard.module(),
            class: featCard.class(),
            ... st,
            event: 'startup',
            helloMessage: _msg,
            status: 'running'
        };
        //console.log( 'itcpserverListening() status', status );
        this.IRunFile.set( _name, status );
        this.IForkable.advertiseParent( status );
    }

    /*
     * Internal stats have been modified
     * @param {Object} status of the ITcpServer
     * [-implementation Api-]
     * Note:
     *  As of v0.x, ITcpServer stats are preferably published in the MQTT alive message.
     *  Keep the runfile as light as possible.
     */
    /*
    itcpserverStatsUpdated( status ){
        const featProvider = this.IFeatureProvider;
        featProvider.api().exports().Msg.debug( 'coreBroker.itcpserverStatsUpdated()' );
        const _name = featProvider.feature().name();
        this.IRunFile.set([ _name, 'ITcpServer' ], status );
    }
    */

    /*
     * @returns {Object[]} the list of implemented commands provided by the interface implementation
     *  cf. tcp-server-command.schema.json
     * [-implementation Api-]
     */
    itcpserverVerbs(){
        return coreBroker.verbs;
    }

    /*
     * @returns {Promise} which must resolve to an object conform to check-status.schema.json
     */
    checkableStatus(){
        const exports = this.IFeatureProvider.api().exports();
        exports.Msg.debug( 'coreBroker.checkableStatus()' );
        const _name = this.IFeatureProvider.feature().name();
        const _json = this.IRunFile.jsonByName( _name );
        let o = new exports.Checkable();
        if( _json && _json[_name] ){
            o.pids = _json[_name].pids;
            o.ports = _json[_name].ports;
            o.startable = o.pids.length === 0 && o.ports.length === 0;
        } else {
            o.startable = true;
        }
        return Promise.resolve( o );
    }

    /*
     * @param {engineApi} api the engine API as described in engine-api.schema.json
     * @param {featureCard} card a description of this feature
     * @returns {Promise} which resolves to the filled feature part configuration
     * Note:
     *  This class aims to provide a IMqttServer.
     *  As a consequence, and even if it is not specified in the configuration, we will also have a IMqttClient
     * Note:
     *  We provide our own default for ITcpServer port to not use the common value
     */
    fillConfig( api, card ){
        api.exports().Msg.debug( 'coreBroker.fillConfig()' );
        let _filled = { ...card.config() };
        if( !_filled.class ){
            _filled.class = this.constructor.name;
        }
        if( !Object.keys( _filled ).includes( 'enabled' )){
            _filled.enabled = true;
        }
        if( Object.keys( _filled ).includes( 'IMqttServer' ) && !Object.keys( _filled ).includes( 'IMqttClient' )){
            _filled.IMqttClient = {};
        }
        if( Object.keys( _filled ).includes( 'ITcpServer' ) && !Object.keys( _filled.ITcpServer ).includes( 'port' )){
            _filled.ITcpServer.port = coreBroker.d.listenPort;
        }
        return Promise.resolve( card.config( _filled ));
    }

    /**
     * @returns {Promise} which resolves to a status Object
     * Note:
     *  The object returned by this function (aka the 'status' object) is used:
     *  - as the answer to the 'iz.status' TCP request
     *  - by the IMQttClient when publishing its 'alive' message
     */
    publiableStatus(){
        const exports = this.IFeatureProvider.api().exports();
        const featCard = this.IFeatureProvider.feature();
        const _serviceName = featCard.name();
        exports.Msg.debug( 'coreBroker.publiableStatus()', 'serviceName='+_serviceName );
        const self = this;
        let status = {};
        // run-status.schema.json (a bit extended here)
        const _runStatus = function(){
            return new Promise(( resolve, reject ) => {
                if( !self._started ) self._started = exports.utils.now();
                const o = {
                    module: featCard.module(),
                    class: featCard.class(),
                    pids: [ process.pid ],
                    ports: [ featCard.config().ITcpServer.port, featCard.config().IMqttServer.port ],
                    runfile: self.IRunFile.runFile( _serviceName ),
                    started: self._started
                };
                exports.Msg.debug( 'coreBroker.publiableStatus()', 'runStatus', o );
                status = { ...status, ...o };
                resolve( status );
            });
        };
        // pidUsage
        const _pidPromise = function(){
            return pidUsage( process.pid )
                .then(( res ) => {
                    const o = {
                        cpu: res.cpu,
                        memory: res.memory,
                        ctime: res.ctime,
                        elapsed: res.elapsed
                    };
                    exports.Msg.debug( 'coreBroker.publiableStatus()', 'pidUsage', o );
                    status.pidUsage = { ...o };
                    return Promise.resolve( status );
                });
        };
        return Promise.resolve( true )
            .then(() => { return _runStatus(); })
            .then(() => { return _pidPromise(); })
            .then(() => { return this.IStatus ? this.IStatus.run( status ) : status; })
            .then(( res ) => {
                let featureStatus = {};
                featureStatus[_serviceName] = res;
                //console.log( 'coreController.publiableStatus() featureStatus', featureStatus );
                return Promise.resolve( featureStatus );
            });
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
        const exports = this.IFeatureProvider.api().exports();
        const featCard = this.IFeatureProvider.feature();
        exports.Msg.debug( 'coreBroker.terminate()' );
        this.ITcpServer.status().then(( res ) => {
            if( res.status === exports.ITcpServer.s.STOPPING ){
                exports.Msg.debug( 'coreBroker.terminate() returning as currently stopping' );
                return Promise.resolve( true );
            }
            if( res.status === exports.ITcpServer.s.STOPPED ){
                exports.Msg.debug( 'coreBroker.terminate() returning as already stopped' );
                return Promise.resolve( true );
            }
        });
        const _name = featCard.name();
        const _module = featCard.module();
        this._forwardPort = words && words[0] && self.api().exports().utils.isInt( words[0] ) ? words[0] : 0;

        const self = this;

        // closing the TCP server
        //  in order the TCP server be closeable, the current connection has to be ended itself
        //  which is done by the promise
        let _promise = Promise.resolve( true )
            .then(() => {
                if( cb && typeof cb === 'function' ){
                    cb({ name:_name, module:_module, class:featCard.class(), pid:process.pid, port:featCard.config().ITcpServer.port });
                }
                return self.ITcpServer.terminate();
            })
            .then(() => {
                // we auto-remove from runfile as late as possible
                //  (rationale: no more runfile implies that the service is no more testable and expected to be startable)
                self.IMqttClient.terminate();
                self.IMqttServer.terminate();
                self.IRunFile.remove( _name );
                exports.Msg.info( _name+' coreBroker terminating with code '+process.exitCode );
                return Promise.resolve( true)
                //process.exit();
            });

        return _promise;
    }
}
