/*
 * main.js
 *
 *  This is the default export of the module.
 *  This is also the Iztiar initialization entry point as this default export is identified in the 'main' key of package.json
 */
import { coreBroker } from './imports.js';

/**
 * @param {coreApi} api
 * @returns {Promise} which must resolves to an IServiceable instance
 */
export default ( api ) => {
    //console.log( '@iztiar/iztiar-broker default exported function()' );
    return new coreBroker( api ).IServiceable;
}
