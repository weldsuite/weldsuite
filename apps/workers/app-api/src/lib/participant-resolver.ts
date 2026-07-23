/**
 * Participant Resolver (app-api copy)
 *
 * Given a meeting attendee or session participant, returns either a
 * `workspaceMemberId` (internal team member) or `personId` (existing or
 * newly auto-created Person in the identity layer). Best-effort: never throws.
 *
 * Ported from apps/core-api/src/lib/participant-resolver.ts — kept in sync
 * with that version. The "find or create person by email" core is delegated to
 * the shared `findOrCreatePersonByEmail` helper in `@weldsuite/db`.
 */

import { eq, sql, isNull, and } from 'drizzle-orm';
import { findOrCreatePersonByEmail } from '@weldsuite/db/lib/person-resolver';
import { generateInitialsAvatarSvg } from '@weldsuite/db/lib/mail-contacts';
import { schema } from '../db';
import { generateId } from './id';

export interface ResolvedParticipantLink {
  workspaceMemberId?: string;
  personId?: string;
  avatarUrl?: string;
  displayName?: string;
}

interface ResolverEnv {
  STORAGE?: R2Bucket;
  R2_PUBLIC_URL?: string;
}

interface ResolverInput {
  email?: string;
  name?: string;
  userId?: string;
}

function buildPersonAvatarPath(
  workspaceId: string,
  personId: string,
): { r2Key: string; publicPath: string } {
  const r2Key = `workspaces/${workspaceId}/avatars/people/${personId}/logo.svg`;
  return { r2Key, publicPath: r2Key };
}

export async function resolveParticipantLink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantDb: any,
  env: ResolverEnv,
  workspaceId: string,
  input: ResolverInput,
): Promise<ResolvedParticipantLink> {
  try {
    const { workspaceMembers, people } = schema;
    const userId = input.userId?.trim();
    const email = input.email?.trim().toLowerCase();
    const name = input.name?.trim();

    // Authenticated workspace member — fastest path, no email lookup needed
    if (userId && !userId.startsWith('guest:')) {
      const [byUserId] = await tenantDb
        .select({
          id: workspaceMembers.id,
          name: workspaceMembers.name,
          picture: workspaceMembers.picture,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);
      if (byUserId) {
        return {
          workspaceMemberId: byUserId.id,
          avatarUrl: byUserId.picture ?? undefined,
          displayName: byUserId.name ?? undefined,
        };
      }
    }

    // Try to find a workspace member by email (handles external-invite → member
    // case where userId is blank but the email is already registered)
    if (email) {
      const [byEmail] = await tenantDb
        .select({
          id: workspaceMembers.id,
          name: workspaceMembers.name,
          picture: workspaceMembers.picture,
        })
        .from(workspaceMembers)
        .where(sql`LOWER(${workspaceMembers.email}) = ${email}`)
        .limit(1);
      if (byEmail) {
        return {
          workspaceMemberId: byEmail.id,
          avatarUrl: byEmail.picture ?? undefined,
          displayName: byEmail.name ?? undefined,
        };
      }
    }

    if (!email) return {};

    // Guest — find or create a Person row in the identity layer
    const resolved = await findOrCreatePersonByEmail(
      tenantDb,
      { email, displayName: name },
      generateId,
    );
    if (!resolved) return {};

    let resolvedAvatarUrl: string | undefined;
    if (!resolved.created) {
      const [existing] = await tenantDb
        .select({ avatarUrl: people.avatarUrl })
        .from(people)
        .where(and(eq(people.id, resolved.personId), isNull(people.deletedAt)))
        .limit(1);
      resolvedAvatarUrl = existing?.avatarUrl ?? undefined;
    }
    const created = resolved.created;
    const resolvedDisplayName: string | undefined = resolved.displayName || name;

    // Generate + persist an initials-SVG avatar for new or avatar-less people.
    if ((created || !resolvedAvatarUrl) && env.STORAGE && env.R2_PUBLIC_URL) {
      try {
        const seedName = name?.trim() || email.split('@')[0] || email;
        const svg = generateInitialsAvatarSvg(seedName);
        const { r2Key, publicPath } = buildPersonAvatarPath(workspaceId, resolved.personId);
        await env.STORAGE.put(r2Key, svg, {
          httpMetadata: { contentType: 'image/svg+xml' },
        });
        resolvedAvatarUrl = `${env.R2_PUBLIC_URL}/${publicPath}`;
        await tenantDb
          .update(people)
          .set({ avatarUrl: resolvedAvatarUrl, updatedAt: new Date() })
          .where(and(eq(people.id, resolved.personId), isNull(people.deletedAt)));
      } catch (err) {
        console.error(
          `[ParticipantResolver] avatar generation failed for workspace ${workspaceId}:`,
          err,
        );
      }
    }

    return {
      personId: resolved.personId,
      avatarUrl: resolvedAvatarUrl,
      displayName: resolvedDisplayName,
    };
  } catch (err) {
    console.error(`[ParticipantResolver] failed for workspace ${workspaceId}:`, err);
    return {};
  }
}

export async function resolveParticipantLinks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantDb: any,
  env: ResolverEnv,
  workspaceId: string,
  inputs: ResolverInput[],
): Promise<ResolvedParticipantLink[]> {
  return Promise.all(
    inputs.map((input) => resolveParticipantLink(tenantDb, env, workspaceId, input)),
  );
}
