/**
 * @weldsuite/workflow-integrations
 *
 * Metadata-only catalog of the third-party providers WeldConnect can connect
 * to. Consumed by app-api (catalog API + OAuth config), workflow-worker (action
 * handlers), integration-webhook-worker (inbound event mapping), and the
 * platform builder UI.
 */

export * from './types';
export * from './registry';
export * from './catalog';
export { GOOGLE_AUTH_BASE, GOOGLE_SCOPES, googleAuth } from './providers/google';
