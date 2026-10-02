/**
 * Member profile service.
 *
 * Combines workspace_members row + selected user_preferences fields
 * (timezone, workingHours) into a single profile view for the team
 * member panel. Server enforces "self or admin" on updates.
 *
 * Ported from apps/core-api/src/services/team/profile.ts.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  MemberProfile,
  UpdateMemberProfileInput,
  MemberProfileLink,
} from '@weldsuite/app-api-client/schemas/team-members';

export interface ProfileViewer {
  userId: string;
  isAdmin: boolean;
}

export async function getMemberProfile(
  db: Database,
  subjectUserId: string,
  viewer: ProfileViewer,
): Promise<MemberProfile | null> {
  const { workspaceMembers, userPreferences } = schema;

  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, subjectUserId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  if (!member) return null;

  const [prefs] = await db
    .select({
      timezone: userPreferences.timezone,
      workingHours: userPreferences.workingHours,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, subjectUserId))
    .limit(1);

  const canEdit = viewer.userId === subjectUserId || viewer.isAdmin;

  return {
    id: member.id,
    userId: member.userId,
    name: member.name,
    email: member.email,
    picture: member.picture,
    role: member.role,
    status: member.status,

    title: member.title ?? null,
    bio: member.bio ?? null,
    phone: member.phone ?? null,
    location: member.location ?? null,
    pronouns: member.pronouns ?? null,
    links: (member.links as MemberProfileLink[] | null) ?? null,

    hoursPerWeek: member.hoursPerWeek ?? null,
    workingHours: (prefs?.workingHours as MemberProfile['workingHours']) ?? null,
    timezone: prefs?.timezone ?? 'UTC',

    canEdit,
  };
}

type MemberPatch = Partial<typeof schema.workspaceMembers.$inferInsert>;
type PrefsPatch = Partial<typeof schema.userPreferences.$inferInsert>;

/** workspace_members columns touched by a profile patch. */
function buildMemberPatch(patch: UpdateMemberProfileInput): MemberPatch {
  const memberPatch: MemberPatch = {};
  if ('title' in patch) memberPatch.title = patch.title ?? null;
  if ('bio' in patch) memberPatch.bio = patch.bio ?? null;
  if ('phone' in patch) memberPatch.phone = patch.phone ?? null;
  if ('location' in patch) memberPatch.location = patch.location ?? null;
  if ('pronouns' in patch) memberPatch.pronouns = patch.pronouns ?? null;
  if ('links' in patch) memberPatch.links = patch.links ?? null;
  if ('hoursPerWeek' in patch) {
    memberPatch.hoursPerWeek = patch.hoursPerWeek == null ? null : String(patch.hoursPerWeek);
  }
  return memberPatch;
}

/** user_preferences columns touched by a profile patch (timezone + workingHours). */
function buildPrefsPatch(patch: UpdateMemberProfileInput): PrefsPatch {
  const prefsPatch: PrefsPatch = {};
  if ('timezone' in patch && patch.timezone) prefsPatch.timezone = patch.timezone;
  if ('workingHours' in patch) {
    prefsPatch.workingHours = patch.workingHours as typeof schema.userPreferences.$inferInsert.workingHours;
  }
  return prefsPatch;
}

/** Update the subject's prefs row, inserting it first when they have none yet. */
async function savePrefsPatch(
  db: Database,
  subjectUserId: string,
  prefsPatch: PrefsPatch,
): Promise<void> {
  const { userPreferences } = schema;
  const [existing] = await db
    .select({ id: userPreferences.id })
    .from(userPreferences)
    .where(eq(userPreferences.userId, subjectUserId))
    .limit(1);

  if (existing) {
    await db
      .update(userPreferences)
      .set(prefsPatch)
      .where(eq(userPreferences.userId, subjectUserId));
    return;
  }
  await db.insert(userPreferences).values({
    id: generateId('upref'),
    userId: subjectUserId,
    ...prefsPatch,
  });
}

export async function updateMemberProfile(
  db: Database,
  subjectUserId: string,
  viewer: ProfileViewer,
  patch: UpdateMemberProfileInput,
): Promise<MemberProfile | null> {
  if (viewer.userId !== subjectUserId && !viewer.isAdmin) {
    throw new Error('FORBIDDEN');
  }

  const { workspaceMembers } = schema;
  const now = new Date();

  // workspace_members fields
  const memberPatch = buildMemberPatch(patch);

  if (Object.keys(memberPatch).length > 0) {
    memberPatch.updatedAt = now;
    await db
      .update(workspaceMembers)
      .set(memberPatch)
      .where(and(eq(workspaceMembers.userId, subjectUserId), isNull(workspaceMembers.deletedAt)));
  }

  // user_preferences fields (timezone + workingHours)
  const prefsPatch = buildPrefsPatch(patch);

  if (Object.keys(prefsPatch).length > 0) {
    prefsPatch.updatedAt = now;
    await savePrefsPatch(db, subjectUserId, prefsPatch);
  }

  return getMemberProfile(db, subjectUserId, viewer);
}
