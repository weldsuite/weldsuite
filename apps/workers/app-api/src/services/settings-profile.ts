/**
 * Self-profile service — the personal "my profile" surface.
 *
 * Ported from apps/api-worker/src/routes/settings/index.ts (~3442-3662), which
 * is the behavioural spec while that worker is being retired.
 *
 * STORE (deliberate — do not "consolidate"):
 * This surface composes `workspace_members` (name/email) with an extended
 * field bag held at `user_preferences.ui_preferences.profile`, plus
 * `user_preferences.timezone`. The picture is the account picture (master
 * `users.image_url`, @weldsuite/worker-kit/account-pictures), the same in
 * every workspace; `workspace_members.picture` is not read or written.
 *
 * It is NOT the `workspace_members` profile COLUMNS (title/bio/phone/location/
 * pronouns/links) that the team-member panel reads through
 * /api/team-members/user/:userId/profile. Those are a SEPARATE store. The two
 * are disconnected today: editing your profile here does not change what the
 * team panel shows. That is a known pre-existing product bug and is out of
 * scope for the port — repointing this surface at those columns would read and
 * write the wrong rows and present as data loss for every existing user.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getMasterDb, schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { loadAccountPicture, type AccountPictureEnv } from '@weldsuite/worker-kit/account-pictures';
import { users } from '@weldsuite/db/schema/master';

/**
 * The extended field bag stored at `ui_preferences.profile`.
 *
 * `profile` is an UNDECLARED key in the `ui_preferences` `$type<>()` over in
 * packages/db. That is fine at runtime — the column is plain JSONB — so it is
 * typed locally here rather than by widening the shared schema.
 */
export interface ExtendedProfile {
  nickname?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  bio?: string;
  timezone?: string;
}

type UiPreferences = NonNullable<typeof schema.userPreferences.$inferSelect['uiPreferences']>;

/** The real runtime shape of `ui_preferences`: the declared keys plus `profile`. */
type UiPreferencesWithProfile = UiPreferences & { profile?: ExtendedProfile };

/** The composed profile returned to the client. */
export interface SelfProfile {
  id: string;
  email: string;
  name: string;
  nickname: string;
  picture: string;
  phone: string;
  company: string;
  jobTitle: string;
  bio: string;
  timezone: string;
}

/** Fields a user may change about themselves. */
export interface UpdateSelfProfileInput {
  name?: string;
  nickname?: string;
  phone?: string;
  jobTitle?: string;
  bio?: string;
  /**
   * Written to the `user_preferences.timezone` COLUMN, not to the `profile`
   * bag — that column is what `composeProfile` reads first, so it is the only
   * value that survives a reload. `ext.timezone` stays read-only (a legacy
   * fallback for rows that predate the column); writing both would let them
   * drift.
   */
  timezone?: string;
}

function memberWhere(userId: string) {
  return and(
    eq(schema.workspaceMembers.userId, userId),
    isNull(schema.workspaceMembers.deletedAt),
  );
}

function prefsWhere(userId: string) {
  return and(
    eq(schema.userPreferences.userId, userId),
    isNull(schema.userPreferences.deletedAt),
  );
}

/**
 * Read `workspace_members` + `user_preferences` and project them into the
 * response shape. Kept in one place so GET and PUT cannot drift apart (legacy
 * duplicated this projection in both handlers).
 */
async function composeProfile(db: Database, env: AccountPictureEnv, userId: string): Promise<SelfProfile> {
  const [[member], [prefs], picture] = await Promise.all([
    db.select().from(schema.workspaceMembers).where(memberWhere(userId)).limit(1),
    db.select().from(schema.userPreferences).where(prefsWhere(userId)).limit(1),
    loadAccountPicture(env, userId),
  ]);

  const uiPrefs = (prefs?.uiPreferences ?? {}) as UiPreferencesWithProfile;
  const ext = uiPrefs.profile ?? {};

  return {
    id: member?.id || userId,
    email: member?.email || '',
    name: member?.name || '',
    nickname: ext.nickname || '',
    picture: picture || '',
    phone: ext.phone || '',
    // `company` is read but never written: it is absent from the update schema
    // in legacy too. Preserved as-is so historical values keep rendering.
    company: ext.company || '',
    jobTitle: ext.jobTitle || '',
    bio: ext.bio || '',
    timezone: prefs?.timezone || ext.timezone || 'UTC',
  };
}

export async function getSelfProfile(db: Database, env: AccountPictureEnv, userId: string): Promise<SelfProfile> {
  return composeProfile(db, env, userId);
}

/**
 * Update the caller's own profile.
 *
 * Writes `name` to the workspace member row, and the extended fields into
 * `ui_preferences.profile`.
 *
 * 🔴 The `ui_preferences` write MERGES rather than replaces. The column also
 * carries sidebarCollapsed, compactMode, sidebarAppOrder, onboardingCompleted,
 * mailDefaultAccountId, mailLastAccountId, homeWidgets and more. Replacing the
 * column here would wipe the user's onboarding state, mail landing preference
 * and home widgets. Both levels merge: the column bag AND the nested `profile`
 * bag (so a partial update never drops a sibling field).
 */
export async function updateSelfProfile(
  db: Database,
  env: AccountPictureEnv,
  userId: string,
  data: UpdateSelfProfileInput,
): Promise<SelfProfile> {
  if (data.name !== undefined) {
    await db
      .update(schema.workspaceMembers)
      .set({ name: data.name, updatedAt: new Date() })
      .where(memberWhere(userId));
  }

  const extFields = pickExtendedFields(data);
  const hasExtFields = Object.keys(extFields).length > 0;

  // `timezone` lives on its own column, so a timezone-only update must still
  // reach the prefs row even when the `profile` bag has nothing to change.
  if (hasExtFields || data.timezone !== undefined) {
    await upsertPreferences(db, userId, extFields, data.timezone);
  }

  return composeProfile(db, env, userId);
}

/** Extended profile fields actually present on the update payload. */
function pickExtendedFields(data: UpdateSelfProfileInput): ExtendedProfile {
  const extFields: ExtendedProfile = {};
  if (data.nickname !== undefined) extFields.nickname = data.nickname;
  if (data.phone !== undefined) extFields.phone = data.phone;
  if (data.jobTitle !== undefined) extFields.jobTitle = data.jobTitle;
  if (data.bio !== undefined) extFields.bio = data.bio;
  return extFields;
}

/** Merge the extended fields / timezone into the caller's prefs row, creating it when missing. */
async function upsertPreferences(
  db: Database,
  userId: string,
  extFields: ExtendedProfile,
  timezone: string | undefined,
): Promise<void> {
  const hasExtFields = Object.keys(extFields).length > 0;
  const [existing] = await db
    .select()
    .from(schema.userPreferences)
    .where(prefsWhere(userId))
    .limit(1);

  if (existing) {
    const currentUiPrefs = (existing.uiPreferences ?? {}) as UiPreferencesWithProfile;
    const currentProfile = currentUiPrefs.profile ?? {};
    const merged: UiPreferencesWithProfile = {
      // Preserve every sibling key on the column …
      ...currentUiPrefs,
      // … and every sibling key inside the profile bag.
      profile: { ...currentProfile, ...extFields },
    };
    await db
      .update(schema.userPreferences)
      .set({
        // Only touch `ui_preferences` when the bag actually changed, so a
        // timezone-only save cannot rewrite (and risk clobbering) it.
        ...(hasExtFields ? { uiPreferences: merged as UiPreferences } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.userPreferences.id, existing.id));
    return;
  }

  const seed: UiPreferencesWithProfile = { profile: extFields };
  await db.insert(schema.userPreferences).values({
    id: generateId('upref'),
    userId,
    ...(hasExtFields ? { uiPreferences: seed as UiPreferences } : {}),
    // Omitted when absent so the column keeps its 'UTC' default.
    ...(timezone !== undefined ? { timezone } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Record the caller's new account picture in the master `users` row, so every
 * workspace shows it on the next read. Clerk's `user.updated` webhook writes
 * the same value shortly after; this saves waiting for it.
 */
export async function saveAccountPicture(
  env: AccountPictureEnv,
  userId: string,
  imageUrl: string,
): Promise<void> {
  await getMasterDb(env)
    .update(users)
    .set({ imageUrl, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
