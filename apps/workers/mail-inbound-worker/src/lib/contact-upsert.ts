/**
 * Mail-contact upsert wrapper for the inbound worker.
 *
 * Wraps the shared `upsertMailContactsBatch` helper from `@weldsuite/db` and
 * additionally generates a default avatar (initials SVG) for any newly created
 * contact, mirroring what helpdesk's POST /contacts route does in api-worker.
 *
 * Failures are swallowed and logged — contact creation must never break the
 * inbound email pipeline.
 */

import { eq } from 'drizzle-orm';
import {
  upsertMailContactsBatch,
  collectMailMessageAddresses,
  generateInitialsAvatarSvg,
  buildContactAvatarPath,
  type MailContactAddress,
} from '@weldsuite/db/lib/mail-contacts';
import { getTenantDbForWorkspaceById, tenantSchema } from '../db';
import type { Env } from '../index';

function generateContactId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Upsert all addresses on a mail message (from + replyTo + to + cc + bcc) for
 * the given workspace. Generates a default initials-SVG avatar for any
 * newly-created contact and writes the public URL to `contacts.avatar_url`.
 *
 * `workspaceId` is the master-DB workspace id (used to route to the tenant DB).
 * `clerkOrgId` is the Clerk organization id used as the path component for R2
 * avatar storage — kept consistent with the api-worker mail send path and the
 * helpdesk POST /contacts route, both of which key avatars under
 * `workspaces/{clerkOrgId}/avatars/contacts/`. If null, contacts are still
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
    const addresses = collectMailMessageAddresses(message);
    if (addresses.length === 0) return;

    const tenantDb = await getTenantDbForWorkspaceById(env, workspaceId);
    const results = await upsertMailContactsBatch(tenantDb, addresses, generateContactId);

    const created = results.filter((r) => r.created);
    if (created.length === 0 || !env.STORAGE) return;

    const r2PublicUrl = env.R2_PUBLIC_URL;
    if (!r2PublicUrl) {
      console.warn('[mail-contacts] R2_PUBLIC_URL not set, skipping avatar generation');
      return;
    }
    if (!clerkOrgId) {
      console.warn(`[mail-contacts] Workspace ${workspaceId} has no clerkOrgId — skipping avatar generation`);
      return;
    }

    // Build a name → email map so we can hash on the same input the UI uses.
    const nameByEmail = new Map<string, string>();
    for (const addr of addresses) {
      const normalized = addr.email.toLowerCase().trim();
      const name = addr.name?.trim() || normalized.split('@')[0] || normalized;
      if (!nameByEmail.has(normalized)) nameByEmail.set(normalized, name);
    }

    for (const row of created) {
      try {
        const seedName = nameByEmail.get(row.email) || row.email;
        const svg = generateInitialsAvatarSvg(seedName);
        const { r2Key, publicPath } = buildContactAvatarPath(clerkOrgId, row.contactId);

        await env.STORAGE.put(r2Key, svg, {
          httpMetadata: { contentType: 'image/svg+xml' },
        });

        const avatarUrl = `${r2PublicUrl}/${publicPath}`;
        await tenantDb
          .update(tenantSchema.contacts)
          .set({ avatarUrl })
          .where(eq(tenantSchema.contacts.id, row.contactId));
      } catch (err) {
        console.error(
          `[mail-contacts] Failed to generate avatar for ${row.email} (${row.contactId}):`,
          err,
        );
      }
    }
  } catch (err) {
    console.error(`[mail-contacts] upsertContactsFromMailMessage failed for workspace ${workspaceId}:`, err);
  }
}
