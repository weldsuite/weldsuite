/**
 * Adapter from this worker's `Env` to the shared publishing package's context,
 * plus the workspace-id translation the package expects.
 *
 * `@weldsuite/social-publishing` knows nothing about worker bindings — each
 * worker maps its own env onto this shape. The master DB is a factory rather
 * than a handle because postgres-js opens a connection eagerly; only calls that
 * actually need master (credit metering, the delivery index) should pay for it.
 */

import { eq } from 'drizzle-orm';
import type { SocialPublishingContext } from '@weldsuite/social-publishing';
import type { Env } from '../types';
import { createMasterDb, masterSchema } from './master-db';

export function socialContext(env: Env): SocialPublishingContext {
  return {
    POSTPEER_API_KEY: env.POSTPEER_API_KEY,
    POSTPEER_BASE_URL: env.POSTPEER_BASE_URL,
    POSTPEER_APP_IDS: env.POSTPEER_APP_IDS,
    masterDb: () => createMasterDb(env.HYPERDRIVE_MASTER),
  };
}

/**
 * Translate this worker's `workspaceId` into the Clerk org id.
 *
 * Worth being explicit about, because the same name means different things
 * either side of this boundary: the API-key session's `workspaceId` is the
 * master `workspaces.id`, while the publishing package keys everything — tenant
 * DB resolution, credit metering, and the delivery index the PostPeer webhook
 * reads — on the Clerk org id. Passing the internal id straight through would
 * appear to work right up until the webhook failed to find the workspace.
 *
 * Returns null when the workspace has no Clerk org, which callers surface as a
 * configuration error rather than a missing post.
 */
export async function resolveClerkOrgId(env: Env, workspaceId: string): Promise<string | null> {
  const [row] = await createMasterDb(env.HYPERDRIVE_MASTER)
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.id, workspaceId))
    .limit(1);
  return row?.clerkOrgId ?? null;
}
