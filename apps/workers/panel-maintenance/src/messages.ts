/**
 * The queue message is shared with panel-api (`@weldsuite/panel-domain/erasure`).
 * Here: the names of the one ledger and the one container instance.
 */

export { panelEraseMessageSchema as eraseMessageSchema, type PanelEraseMessage as EraseMessage } from '@weldsuite/panel-domain/erasure';

/** The one ledger instance. */
export const LEDGER_NAME = 'global';
/** The one container instance: a rewrite at a time. */
export const JOB_NAME = 'job';
