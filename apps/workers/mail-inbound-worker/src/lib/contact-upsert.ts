/**
 * Mail-contact upsert for the inbound worker.
 *
 * Thin wrapper over `upsertMailContacts` from `@weldsuite/mail-domain/contacts`
 * (the same helper mail-api's send path uses): upserts every address on the
 * message into `people` and gives each newly created person an initials-SVG
 * avatar.
 *
 * Failures are swallowed and logged — contact creation must never break the
 * inbound email pipeline.
 */

import { upsertMailContacts } from '@weldsuite/mail-domain/contacts';
import type { MailContactAddress } from '@weldsuite/db/lib/mail-contacts';
import { getTenantDbForWorkspaceById } from '../db';
import type { Env } from '../index';

/**
 * Upsert all addresses on a mail message (from + replyTo + to + cc + bcc) for
 * the given workspace.
 *
 * `workspaceId` is the master-DB workspace id (used to route to the tenant DB).
 * `clerkOrgId` is the Clerk organization id used as the path component for R2
 * avatar storage, the same key mail-api's send path uses
 * (`workspaces/{clerkOrgId}/avatars/people/`). If null, contacts are still
 * upserted but avatar generation is skipped.
 */
export async function upsertContactsFromMailMessage(
  env: Env,
  workspaceId: string,
  clerkOrgId: string | null,
  message: {
    from?: MailContactAddress | null;
    to?: MailContactAddress[] | null;
    cc?: MailContactAddress[] | null;
    bcc?: MailContactAddress[] | null;
    replyTo?: MailContactAddress | null;
  },
): Promise<void> {
  try {
    const tenantDb = await getTenantDbForWorkspaceById(env, workspaceId);
    // Without a Clerk org there is no avatar path: pass no storage so only the people rows are written.
    await upsertMailContacts(clerkOrgId ? env : {}, tenantDb, clerkOrgId ?? workspaceId, message);
  } catch (err) {
    console.error(`[mail-contacts] upsertContactsFromMailMessage failed for workspace ${workspaceId}:`, err);
  }
}
