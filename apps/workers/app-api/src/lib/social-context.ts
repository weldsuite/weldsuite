/**
 * Adapter from this worker's `Env` to the shared publishing package's context.
 *
 * `@weldsuite/social-publishing` deliberately knows nothing about worker
 * bindings — each worker maps its own env onto this shape. The master DB is a
 * factory rather than a handle so it is only built when a call actually needs
 * it (credit metering and the delivery index).
 */

import type { SocialPublishingContext } from '@weldsuite/social-publishing';
import type { Env } from '../types';
import { getMasterDb } from '../db';

export function socialContext(env: Env): SocialPublishingContext {
  return {
    POSTPEER_API_KEY: env.POSTPEER_API_KEY,
    POSTPEER_BASE_URL: env.POSTPEER_BASE_URL,
    POSTPEER_APP_IDS: env.POSTPEER_APP_IDS,
    masterDb: () => getMasterDb(env),
  };
}
