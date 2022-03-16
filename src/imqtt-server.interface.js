/*
 * IMqttServer interface
 *
 * The class is only instanciated and started in an already forked process.
 */
import Aedes from 'aedes';
import { createServer } from 'aedes-server-factory';

export class IMqttServer {

    static s = {
        STARTING: 'starting',
        RUNNING: 'running',
        STOPPING: 'stopping',
        STOPPED: 'stopped'
    };

    // implementation instance
    _instance = null;

    // messaging subserver
    _aedesServer = null;

    // messaging server
    _mqttServer = null;

    // messaging port
    _mqttPort = null;

    // server status
    _status = null;

    /**
     * Constructor
     * @param {*} instance the implementation instance
     * @returns {IMqttServer}
     */
     constructor( instance ){
        instance.api().exports().Msg.debug( 'IMqttServer instanciation' );
        this._instance = instance;
        this._status = IMqttServer.s.STOPPED;
        return this;
    }

    /* *** ***************************************************************************************
       *** The implementation API, i.e; the functions the implementation may want to implement ***
       *** *************************************************************************************** */

    /**
     * What to do when this IMqttServer is ready listening ?
     * [-implementation Api-]
     */
    _listening(){
        this._instance.api().exports().Msg.debug( 'IMqttServer._listening()' );
    }

    /* *** ***************************************************************************************
       *** The public API, i.e; the API anyone may call to access the interface service        ***
       *** *************************************************************************************** */

    /**
     * @returns {Promise} which resolves when the server is actually started
     * Note:
     *  The caller should take care of never terminating its process if it wants keep this IMqttServer alive.
     *  This may be obtained by returning iself a Promise which never resolves: return new Promise(() => {});
     * [-public API-]
     */
    create( port ){
        const Msg = this._instance.api().exports().Msg;
        Msg.debug( 'IMqttServer.create()' );
        this.status( IMqttServer.s.STARTING );
        this._mqttPort = port;
        const self = this;

        // start aedes aka messaging subserver
        if( !this._aedesServer ){
            this._aedesServer = new Aedes.Server();
        }

        // start mqtt aka messaging server
        if( !this._mqttServer ){
            this._mqttServer = createServer( this._aedesServer );
        }

        this._mqttServer
            .on( 'error', ( e ) => {
                self.errorHandler( e );
            });

        Msg.debug( 'IMqttServer.create() IMqttServer created' );

        return new Promise(( resolve, reject ) => {
            self._mqttServer.listen( self._mqttPort, '0.0.0.0', () => {
                self.status( IMqttServer.s.RUNNING );
                self._listening();
                resolve( true );
            });
        });
    }

    /**
     * An error handler for implementation classes
     * @param {Error} e exception on MQTT server listening
     */
    errorHandler( e ){
        const Msg = this._instance.api().exports().Msg;
        Msg.debug( 'IMqttServer:errorHandler()' );
        if( e.stack ){
            Msg.error( 'IMqttServer:errorHandler()', e.name, e.message );
        }
        // for now, do not terminate on ECONNRESET
        //if( e.code === 'ECONNRESET' ){
        //    return;
        //}
        // not very sure this is a good idea !?
        if( this.status().status !== IMqttServer.s.STOPPING ){
            Msg.info( 'auto-killing on '+e.code+' error' );
            this.status( ITcpServer.s.STOPPING );
            process.kill( process.pid, 'SIGTERM' );
            //process.kill( process.pid, 'SIGKILL' ); // if previous is not enough ?
        }
    }

    /**
     * Getter/Setter
     * @param {String} newStatus the status to be set to the IMqttServer
     * @returns {Object} the status of the IMqttServer
     */
    status( newStatus ){
        const Msg = this._instance.api().exports().Msg;
        Msg.debug( 'IMqttServer.status()', 'status='+this._status, 'newStatus='+newStatus );
        if( newStatus && typeof newStatus === 'string' && newStatus.length && Object.values( IMqttServer.s ).includes( newStatus )){
            this._status = newStatus;
        }
        const o = {
            status: this._status,
            port: this._port
        };
        //Msg.debug( 'IMqttServer.status()', o );
        return o;
    }

    /**
     * Terminate this IMqttServer
     * @returns {Promise} which resolves when the server is actually closed
     */
    terminate(){
        const Msg = this._instance.api().exports().Msg;
        Msg.debug( 'IMqttServer.terminate()' );
        if( this.status().status === IMqttServer.s.STOPPING ){
            Msg.debug( 'IMqttServer.terminate() returning as already stopping' );
            return;
        }
        if( this.status().status === IMqttServer.s.STOPPED ){
            Msg.debug( 'IMqttServer.terminate() returning as already stopped' );
            return;
        }

        // we advertise we are stopping as soon as possible
        this.status( IMqttServer.s.STOPPING );
        const self = this;

        // stopping the messaging subserver
        const _subserverPromise = function(){
            return new Promise(( resolve, reject ) => {
                if( !self._aedesServer ){
                    Msg.warn( 'IMqttServer.terminate() messaging subserver is not set' );
                    resolve( true );
                } else {
                    Msg.info( 'IMqttServer.terminate() terminating the messaging subserver' );
                    self._aedesServer.close(() => {
                        Msg.verbose( 'IMqttServer.terminate() messaging subserver successfully stopped' );
                        self._aedesServer = null;
                        resolve (true );
                    })
                }
            });
        }

        // stopping the messaging server
        const _serverPromise = function(){
            return new Promise(( resolve, reject ) => {
                if( !self._mqttServer ){
                    Msg.warn( 'IMqttServer.terminate() messaging server is not set' );
                    resolve( true );
                } else {
                    Msg.info( 'IMqttServer.terminate() terminating the messaging server' );
                    self._mqttServer.close(() => {
                        Msg.verbose( 'IMqttServer.terminate() messaging server successfully stopped' );
                        resolve( true );
                    })
                }
            });
        }

        let promise = Promise.resolve( true )
            .then(() => { return _subserverPromise()})
            .then(() => { return _serverPromise()})
            .then(() => {
                self.status( IMqttServer.s.STOPPED );
                return Promise.resolve( true );
            });

        return promise;
    }
}
