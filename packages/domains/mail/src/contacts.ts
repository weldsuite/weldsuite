/**
 * Upsert mail message addresses into the shared `people` (contacts) table
 * and generate an initials-SVG avatar for any newly created row.
 *
 * All errors are swallowed and logged — contact upsert never gates the
 * parent send/save flow it was called from.
 */

import { eq } from 'drizzle-orm';
import {
  upsertMailContactsBatch,
  collectMailMessageAddresses,
  generateInitialsAvatarSvg,
  buildContactAvatarPath,
  type MailContactAddress,
} from '@weldsuite/db/lib/mail-contacts';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

/** The bindings upsertMailContacts reads (any worker Env with them fits). */
export interface MailContactsEnv {
  /** R2 bucket for the generated contact avatars. */
  STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;
}

export async function upsertMailContacts(
  env: MailContactsEnv,
  tenantDb: Database,
  workspaceId: string,
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

    const results = await upsertMailContactsBatch(tenantDb, addresses, generateId);

    const created = results.filter((r) => r.created);
    if (created.length === 0 || !env.STORAGE || !env.R2_PUBLIC_URL) return;

    const nameByEmail = new Map<string, string>();
    for (const addr of addresses) {
      const normalized = addr.email.toLowerCase().trim();
      const name = addr.name?.trim() || normalized.split('@')[0] || normalized;
      if (!nameByEmail.has(normalized)) nameByEmail.set(normalized, name);
    }

    // Each new contact gets its own avatar object and row update — independent, so run them together.
    const storage = env.STORAGE;
    const publicUrl = env.R2_PUBLIC_URL;
    await Promise.all(
      created.map(async (row) => {
        try {
          const seedName = nameByEmail.get(row.email) || row.email;
          const svg = generateInitialsAvatarSvg(seedName);
          const { r2Key, publicPath } = buildContactAvatarPath(workspaceId, row.contactId);

          await storage.put(r2Key, svg, {
            httpMetadata: { contentType: 'image/svg+xml' },
          });

          const avatarUrl = `${publicUrl}/${publicPath}`;
          await tenantDb
            .update(schema.people)
            .set({ avatarUrl })
            .where(eq(schema.people.id, row.contactId));
        } catch (err) {
          console.error(
            `[mail-contacts] Failed to generate avatar for ${row.email} (${row.contactId}):`,
            err,
          );
        }
      }),
    );
  } catch (err) {
    console.error(`[mail-contacts] upsertMailContacts failed for workspace ${workspaceId}:`, err);
  }
}
