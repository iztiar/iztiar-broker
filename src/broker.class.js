/*
 * coreBroker class
 */
import { IMqttServer } from './imports.js';

export class coreBroker {

    /**
     * Default ports number
     */
    static d = {
        listenPort: 24002
    };

    /**
     * The commands which can be received by the coreBroker via the TCP communication port
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
    // cannot wait for the server to terminate, because the server itself waits for this answer be sent
    static _izStop( self, reply ){
        self.terminate( reply.args, ( res ) => {
            reply.answer = res;
            self.api().exports().Msg.debug( 'coreBroker.izStop()', 'replying with', reply );
            return Promise.resolve( reply );
        });
        return Promise.resolve( true );
    }

    // when this feature has started
    _started = null;

    /**
     * @param {engineApi} api the engine API as described in engine-api.schema.json
     * @param {featureCard} card a description of this feature
     * @returns {Promise} which resolves to a coreBroker instance
     */
    constructor( api, card ){
        const exports = api.exports();
        const Interface = exports.Interface;
        const Msg = exports.Msg;

        // must derive from featureProvider
        Interface.extends( this, exports.featureProvider, api, card );
        Msg.debug( 'coreBroker instanciation' );

        let _promise = this.fillConfig()
            .then(() => {
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
                return Interface.fillConfig( this, 'ICapability' );
            })
            .then(() => {
                Interface.add( this, exports.IForkable, {
                    v_start: this.iforkableStart,
                    v_status: this.iforkableStatus,
                    v_stop: this.iforkableStop
                });
                return Interface.fillConfig( this, 'IForkable' );
            })
            .then(() => {
                // declare IMqttServer before IMqttClient because the former forces the presence of the later
                Interface.add( this, IMqttServer );
                return Interface.fillConfig( this, 'IMqttServer' );
            })
            .then(() => {
                Interface.add( this, exports.IMqttClient, {
                    v_alive: this.imqttclientAlive
                });
                return Interface.fillConfig( this, 'IMqttClient' );
            })
            .then(() => {
                Interface.add( this, exports.IRunFile, {
                    v_runDir: this.irunfileRunDir
                });
                return Interface.fillConfig( this, 'IRunFile' );
            })
            .then(() => {
                Interface.add( this, exports.ITcpServer, {
                    v_listening: this.itcpserverListening
                });
                return Interface.fillConfig( this, 'ITcpServer' );
            })
            .then(() => { return Promise.resolve( this ); });

        return _promise;
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
    iforkableStart( name, cb, args ){
        const exports = this.api().exports();
        const _forked = exports.IForkable.forkedProcess();
        exports.Msg.debug( 'coreBroker.iforkableStart()', 'forkedProcess='+_forked );
        if( _forked ){
            const featCard = this.feature();
            return Promise.resolve( true )
                .then(() => { this.ITcpServer.create( featCard.config().ITcpServer.port ); })
                .then(() => { exports.Msg.debug( 'coreBroker.iforkableStart() tcpServer created' ); })
                .then(() => { this.IMqttServer.create( featCard.config().IMqttServer.port ); })
                .then(() => { exports.Msg.debug( 'coreBroker.iforkableStart() mqttServer created' ); })
                .then(() => { this._started = exports.utils.now(); })
                .then(() => { this.IMqttClient.connects(); })
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
    iforkableStatus(){
        const exports = this.api().exports();
        exports.Msg.debug( 'coreBroker.iforkableStatus()' );
        exports.utils.tcpRequest( this.feature().config().ITcpServer.port, 'iz.status' )
            .then(( answer ) => {
                exports.Msg.debug( 'coreBroker.iforkableStatus()', 'receives answer to \'iz.status\'', answer );
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
    iforkableStop(){
        const exports = this.api().exports();
        exports.Msg.debug( 'coreBroker.iforkableStop()' );
        return exports.utils.tcpRequest( this.feature().config().ITcpServer.port, 'iz.stop' )
            .then(( answer ) => {
                exports.Msg.debug( 'coreBroker.iforkableStop()', 'receives answer to \'iz.stop\'', answer );
            }, ( failure ) => {
                // an error message is already sent by the called self.api().exports().utils.tcpRequest()
                //  what more to do ??
                //IMsg.error( 'TCP error on iz.stop command:', failure );
            });
    }

    /*
     * @returns {Promise} which resolves to the payload of the 'alive' message
     * we want here publish the content of our status (without the 'name' top key)
     * [-implementation Api-]
     */
    imqttclientAlive(){
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
        this.api().exports().Msg.debug( 'coreBroker.irunfileRunDir()' );
        return this.api().config().runDir();
    }

    /*
     * What to do when this ITcpServer is ready listening ?
     *  -> write the runfile before advertising parent to prevent a race condition when writing the file
     *  -> send the current service status
     * @param {Object} tcpServerStatus
     * [-implementation Api-]
     */
    itcpserverListening( tcpServerStatus ){
        const exports = this.api().exports();
        exports.Msg.debug( 'coreBroker.itcpserverListening()' );
        const featCard = this.feature();
        const _name = featCard.name();
        const _port = featCard.config().ITcpServer.port;
        let _msg = 'Hello, I am \''+_name+'\' '+featCard.class();
        _msg += ', running with pid '+process.pid+ ', listening on port '+_port;
        let st = new exports.Checkable();
        st.pids = [ process.pid ];
        st.ports = [ _port ];
        delete st.startable;
        delete st.reasons;
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
     * @returns {Promise} which must resolve to an object conform to check-status.schema.json
     */
    checkableStatus(){
        const exports = this.api().exports();
        exports.Msg.debug( 'coreBroker.checkableStatus()' );
        const _name = this.feature().name();
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
     * @returns {Promise} which resolves to the filled feature configuration
     * Note:
     *  This class aims to provide a IMqttServer.
     *  As a consequence, and even if it is not specified in the configuration, we will also have a IMqttClient
     * Note:
     *  We provide our own default for ITcpServer port to not use the common value
     */
    fillConfig(){
        let _promise = super.fillConfig();
        const exports = this.api().exports();
        exports.Msg.debug( 'coreBroker.fillConfig()' );
        let _config = this.feature().config();
        if( !Object.keys( _config ).includes( 'class' )){
            _config.class = this.constructor.name;
        }
        if( Object.keys( _config ).includes( 'IMqttServer' ) && !Object.keys( _config ).includes( 'IMqttClient' )){
            _config.IMqttClient = {};
        }
        if( Object.keys( _config ).includes( 'ITcpServer' ) && !Object.keys( _config.ITcpServer ).includes( 'port' )){
            _config.ITcpServer.port = coreBroker.d.listenPort;
        }
        return _promise;
    }

    /*
     * If the service had to be SIGKILL'ed to be stoppped, then gives it an opportunity to make some cleanup
     */
    postStop(){
        super.postStop();
        this.api().exports().Msg.debug( 'coreBroker.postStop()' );
        this.IRunFile.remove( this.feature().name());
    }

    /**
     * @returns {Promise} which resolves to a status Object
     * Note:
     *  The object returned by this function (aka the 'status' object) is used:
     *  - as the answer to the 'iz.status' TCP request
     *  - by the IMQttClient when publishing its 'alive' message
     */
    publiableStatus(){
        const exports = this.api().exports();
        const featCard = this.feature();
        const _serviceName = featCard.name();
        exports.Msg.debug( 'coreBroker.publiableStatus()', 'serviceName='+_serviceName );
        const self = this;
        let status = {};
        // run-status.schema.json (a bit extended here)
        const _runStatus = function(){
            return new Promise(( resolve, reject ) => {
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
        return Promise.resolve( true )
            .then(() => { return _runStatus(); })
            .then(() => { return this.IStatus ? this.IStatus.run( status ) : status; })
            .then(( res ) => {
                let featureStatus = {};
                featureStatus[_serviceName] = res;
                //console.log( 'coreController.publiableStatus() featureStatus', featureStatus );
                return Promise.resolve( featureStatus );
            });
    }

    /*
     * Called on each and every loaded add-on when the main hosting feature has terminated with its initialization
     * Time, for example, to increment all interfaces we are now sure they are actually implemented
     * Here: add verbs to ITcpServer
     */
    ready(){
        super.ready();
        const exports = this.api().exports();
        exports.Msg.debug( 'coreBroker.ready()' );
        const self = this;
        Object.keys( coreBroker.verbs ).every(( key ) => {
            const o = coreBroker.verbs[key];
            self.ITcpServer.add( key, o.label, o.fn, o.end ? o.end : false );
            return true;
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
        const exports = this.api().exports();
        const featCard = this.feature();
        exports.Msg.debug( 'coreBroker.terminate()' );

        const _name = featCard.name();
        const _module = featCard.module();
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
            .then(() => { return self.IMqttClient.terminate(); })
            .then(() => { return self.IMqttServer.terminate(); })
            .then(() => {
                // we auto-remove from runfile as late as possible
                //  (rationale: no more runfile implies that the service is no more testable and expected to be startable)
                self.IRunFile.remove( _name );
                exports.Msg.info( _name+' coreBroker terminating with code '+process.exitCode );
                return Promise.resolve( true)
                //process.exit();
            });

        return _promise;
    }
}
