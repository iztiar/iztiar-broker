/*
 * main.js
 *
 *  This is the default export of the module.
 *  This is also the Iztiar initialization entry point as this default export is identified in the 'main' key of package.json
 */
import { coreBroker } from './imports.js';

/**
 * @param {engineApi} api the engine API as described in engine-api.schema.json
 * @param {featureCard} card a description of this feature
 * @returns {Promise} which must resolves to an IFeatureProvider instance
 */
export default ( api, card ) => {
    //console.log( '@iztiar/iztiar-broker default exported function()' );
    //console.log( api );
    return new coreBroker( api, card );
}
