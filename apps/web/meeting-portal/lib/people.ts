import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import { generateInitialsAvatarSvg } from '@weldsuite/db/lib';
import { uploadToR2, isR2Configured } from './storage/r2';

const { people } = schema;

function generatePersonId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `person_${timestamp}${random}`;
}

function buildPersonAvatarPath(workspaceId: string, personId: string): {
  r2Key: string;
  publicPath: string;
} {
  const r2Key = `workspaces/${workspaceId}/avatars/people/${personId}/logo.svg`;
  return { r2Key, publicPath: r2Key };
}

/**
 * Generate an initials SVG, upload it to R2 at the canonical person-avatar
 * path, and return the resulting public URL. Returns null when R2 isn't
 * configured or the upload fails — the caller decides whether to leave the
 * person's avatarUrl null or fall back to something else.
 *
 * Mirrors the people-avatar pipeline in
 * `apps/core-api/src/lib/participant-resolver.ts`, so people created from the
 * meeting-portal are visually consistent with people created via core-api.
 */
async function generateAndUploadPersonAvatar(
  workspaceId: string,
  personId: string,
  seedName: string,
): Promise<string | null> {
  if (!isR2Configured()) {
    console.warn('[meeting-portal/people] R2 not configured, skipping avatar upload');
    return null;
  }
  try {
    const svg = generateInitialsAvatarSvg(seedName);
    const { r2Key } = buildPersonAvatarPath(workspaceId, personId);
    return await uploadToR2(r2Key, svg, 'image/svg+xml');
  } catch (err) {
    console.error(`[meeting-portal/people] avatar upload failed for ${personId}:`, err);
    return null;
  }
}

/**
 * Look up a person in the workspace identity layer by email (case-insensitive).
 * If none exists, create one with firstName/lastName derived from the guest's
 * display name (split on the first space), generate an initials SVG avatar,
 * upload it to R2, and store the public URL on the row.
 *
 * Minimal mirror of the canonical
 * `findOrCreatePersonByEmail` in `apps/core-api/src/services/people.ts` —
 * meeting-portal runs on Next.js (separate Drizzle client), so it ships its
 * own helper. Skips the `ensureWrappingParty` dual-write because guest-joined
 * people aren't customers/suppliers.
 *
 * Note: meeting-portal runs on Next.js (no Cloudflare queue bindings),
 * so the standard `person:created` entity event is NOT published here.
 */
export async function findOrCreatePersonByEmail(
  db: any,
  params: { email: string; name: string; workspaceId: string },
): Promise<{ id: string; avatarUrl: string | null; created: boolean }> {
  const email = params.email.trim().toLowerCase();

  const [existing] = await db
    .select({ id: people.id, avatarUrl: people.avatarUrl })
    .from(people)
    .where(and(
      sql`lower(${people.email}) = ${email}`,
      isNull(people.deletedAt),
    ))
    .limit(1);

  if (existing) {
    let avatarUrl = existing.avatarUrl ?? null;
    // Backfill: a person matched by email but with no stored avatar (e.g.
    // imported, or created by a flow that didn't generate one) gets one
    // generated + uploaded now. Without this the guest would fall back to
    // bare initials on every meeting tile despite an existing CRM record —
    // the request is "use the existing avatar, otherwise create one".
    if (!avatarUrl) {
      const seedName = params.name.trim() || email.split('@')[0] || 'Guest';
      avatarUrl = await generateAndUploadPersonAvatar(params.workspaceId, existing.id as string, seedName);
      if (avatarUrl) {
        await db
          .update(people)
          .set({ avatarUrl, updatedAt: new Date() })
          .where(and(eq(people.id, existing.id as string), isNull(people.deletedAt)));
      }
    }
    return { id: existing.id as string, avatarUrl, created: false };
  }

  const trimmedName = params.name.trim();
  const spaceIdx = trimmedName.indexOf(' ');
  const firstName = (spaceIdx === -1 ? trimmedName : trimmedName.slice(0, spaceIdx)).trim() || 'Guest';
  const lastName  = spaceIdx === -1 ? ''           : trimmedName.slice(spaceIdx + 1).trim();
  const fullName  = trimmedName || 'Guest';
  const displayName = fullName;

  const id = generatePersonId();
  const now = new Date();
  await db.insert(people).values({
    id,
    firstName,
    lastName,
    fullName,
    displayName,
    email,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    version: 1,
  });

  // Generate + upload the avatar AFTER the insert so personId is fixed.
  // Failures don't roll back the person — a missing avatar is recoverable,
  // a missing person row would silently break the join's CRM link.
  const avatarUrl = await generateAndUploadPersonAvatar(params.workspaceId, id, fullName);
  if (avatarUrl) {
    await db
      .update(people)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(and(eq(people.id, id), isNull(people.deletedAt)));
  }

  return { id, avatarUrl, created: true };
}
