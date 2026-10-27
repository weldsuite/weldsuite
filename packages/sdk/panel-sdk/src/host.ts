/**
 * The collector, which also serves the snippet. Its own module, so
 * `./install` (imported by panel-api, a Worker) doesn't pull in browser code.
 */
export const DEFAULT_HOST = 'https://pnl.weldsuite.org';
