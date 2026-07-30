/**
 * Driver registration.
 *
 * Importing this module is what puts drivers in the registry, so anything that
 * resolves a driver by id must import it first. The route modules and the queue
 * consumer both do.
 *
 * Registration is a side effect of import rather than a call each entry point
 * makes, so there is exactly one place that decides which drivers ship.
 */

import { registerDriver } from '@weldsuite/connectors';
import { moneybirdDriver } from './moneybird';

registerDriver(moneybirdDriver);

export { moneybirdDriver };
