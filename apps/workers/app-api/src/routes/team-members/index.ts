/**
 * Team-member routes — flat /api/team-members/* surface backed by
 * `workspace_members` (directory + profile data), `user_preferences`
 * (timezone / working hours), `member_notes` (per-viewer private notes)
 * and `audit_logs` (member activity feed). Keeps both the tenant DB and the
 * Clerk org in sync for invite / role-change / remove flows.
 *
 * Migrated from apps/core-api/src/routes/team/* (members, manage, sync,
 * profile). Sub-paths are preserved so the unified surface mirrors the old
 * /api/team/members/* layout:
 *
 *   GET    /me                       — current user's member row
 *   GET    /                         — directory listing (visibility-projected)
 *   POST   /sync                     — reconcile tenant DB vs Clerk org   [team:read]
 *   POST   /invite                   — create Clerk invitation + PENDING row
 *   GET    /:id                      — single member (visibility-projected)
 *   PATCH  /:id                      — role (Clerk + DB) / name / permission
 *                                      overrides / hoursPerWeek           [team:update]
 *   DELETE /:id                      — remove from Clerk + soft-delete     [team:delete]
 *   POST   /:id/resend-invite        — re-issue Clerk invitation           [team:update]
 *   GET    /:id/permissions          — role vs override breakdown          [team:read]
 *   GET    /:id/apps                 — installed apps + assignment status  [team:read]
 *   POST   /:id/apps/toggle          — grant/revoke one app for a member   [team:update]
 *   GET    /user/:userId/profile     — full profile (self-or-admin edit flag)
 *   PATCH  /user/:userId/profile     — update profile (self or admin)
 *   GET    /user/:userId/notes       — viewer's own private note
 *   PUT    /user/:userId/notes       — upsert viewer's note
 *   DELETE /user/:userId/notes       — delete viewer's note
 *   GET    /user/:userId/common      — shared channels/projects/tasks/crm/helpdesk
 *   GET    /user/:userId/activity    — member audit-log feed (self or team:read)
 *
 * Permission prefix: `team:*` (plus `team:invite_external` for guest invites).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, isNotNull, notInArray } from 'drizzle-orm';
import {
  requirePermission,
  hasContextPermission,
  getPermissionsFromContext,
  resolveEffectivePermissions,
  createDrizzlePermissionQueries,
} from '@weldsuite/permissions/server';
import { hasAppPermission } from '@weldsuite/permissions';
import {
  inviteMemberSchema,
  updateMemberInput,
  updateMemberProfileInput,
  memberNoteInput,
  commonConceptsQuery,
  listMemberActivityQuery,
} from '@weldsuite/app-api-client/schemas/team-members';
import type { Env, Variables } from '../../types';
import { error, noContent, success, list, cursorPagination } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import * as membersService from '../../services/team/members';
import type { Visibility } from '../../services/team/members';
import * as profileService from '../../services/team/profile';
import * as notesService from '../../services/team/notes';
import * as commonService from '../../services/team/common-concepts';
import * as activityService from '../../services/team/activity';
import * as memberAccessService from '../../services/team/member-access';
import { getWorkspaceSeatLimit, type SeatLimit } from '../../services/seat-limits';
import { alignClerkCapWithPlan } from '../../services/clerk-seat-cap';
import { syncClerkSeatLimit } from '../../services/billing';
import { logSafe } from '@weldsuite/worker-kit/log-safe';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Body for POST /:id/apps/toggle. Mirrors api-worker's toggleAppAccessSchema.
 * Kept local rather than in @weldsuite/app-api-client because that package's
 * export map is per-file and adding an entry means touching its package.json,
 * which is the integrator's file. Promote it if a second client needs it.
 */
const toggleMemberAppSchema = z.object({
  appCode: z.string().min(1),
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/**
 * Resolve visibility for a directory request. Lazily resolves the user's
 * effective permissions if no enforcing middleware ran on this route, so
 * `team:read` (granted to OWNER/ADMIN by wildcard) correctly maps to admin
 * visibility and `roleId` / `email` / `permissions` are projected through.
 */
async function getVisibility(c: any): Promise<Visibility> {
  if (await hasContextPermission(c, 'team:read')) {
    return 'admin';
  }
  return 'public';
}

/**
 * Load the viewer's permissions into context if not already cached. Needed
 * because the profile/common/activity routes check permissions conditionally
 * (self-or-admin) rather than via requirePermission(). Idempotent.
 */
async function ensurePermissionsLoaded(c: any): Promise<void> {
  if (getPermissionsFromContext(c)) return;
  const userId: string | undefined = c.get('userId');
  if (!userId) return;
  const queries = createDrizzlePermissionQueries(c.get('tenantDb'), schema, { eq, and, isNull });
  const resolved = await resolveEffectivePermissions(queries, userId);
  c.set('userPermissions', resolved);
}

function viewerIsAdmin(c: any): boolean {
  const perms = getPermissionsFromContext(c);
  if (!perms) return false;
  return hasAppPermission(perms, 'team:update', null);
}

function viewerCanReadMemberActivity(c: any, viewerUserId: string, subjectUserId: string): boolean {
  // Users can always see their own activity.
  if (viewerUserId === subjectUserId) return true;
  const perms = getPermissionsFromContext(c);
  if (!perms) return false;
  return hasAppPermission(perms, 'team:read', null);
}

// ---------------------------------------------------------------------------
// Clerk helpers (member management)
// ---------------------------------------------------------------------------

function clerkHeaders(secretKey: string) {
  return {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };
}

function mapRoleToClerk(roleName: string): 'org:admin' | 'org:member' {
  return roleName.toUpperCase() === 'ADMIN' ? 'org:admin' : 'org:member';
}

async function lookupRole(db: Database, roleId: string) {
  const [role] = await db
    .select({ id: schema.roles.id, name: schema.roles.name })
    .from(schema.roles)
    .where(and(eq(schema.roles.id, roleId), isNull(schema.roles.deletedAt)))
    .limit(1);
  return role ?? null;
}

/** Permissions automatically granted to a fresh EXTERNAL_GUEST member. */
const GUEST_DEFAULT_PERMISSIONS = [
  'channels:read',
  'channels:create_message',
  'channels:update_own',
];

/**
 * Look up an existing Clerk user by email. Returns the user_id if exactly
 * one match is found, or null otherwise. Used by the guest invite flow to
 * skip the email-roundtrip when the person already has a Clerk identity.
 */
async function findClerkUserIdByEmail(
  secretKey: string,
  email: string,
): Promise<string | null> {
  const resp = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}&limit=2`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  if (!resp.ok) return null;
  const data = (await resp.json().catch(() => [])) as Array<{ id: string }>;
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0]?.id ?? null;
}

// ===========================================================================
// Read — /me and directory listing
// ===========================================================================

/**
 * GET /me — return the current user's workspace_member row.
 *
 * Defined BEFORE GET /:id so the literal `me` segment wins the route match.
 * Used by the platform shell to read `memberType` (drives sidebar filtering
 * and route gating for external guests).
 */
app.get('/me', async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');

  try {
    const { workspaceMembers } = schema;
    const [row] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: workspaceMembers.email,
        name: workspaceMembers.name,
        picture: workspaceMembers.picture,
        role: workspaceMembers.role,
        roleId: workspaceMembers.roleId,
        permissions: workspaceMembers.permissions,
        status: workspaceMembers.status,
        memberType: workspaceMembers.memberType,
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
      .limit(1);

    if (!row) return error.notFound(c, 'Member', userId);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/team-members] /me failed:', err);
    return error.internal(c, 'Failed to fetch current member');
  }
});

app.get('/', async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const visibility = await getVisibility(c);
  const query = c.req.query();

  // memberType filter:
  //   ?memberType=INTERNAL        (default — full team members only)
  //   ?memberType=EXTERNAL_GUEST  (guests only)
  //   ?memberType=EMPLOYEE        (My HR-only employee members)
  //   ?memberType=all             (every type)
  // Legacy alias: ?include=guests → maps to memberType=all so older callers
  // (chat member picker) keep working.
  let memberType: 'INTERNAL' | 'EXTERNAL_GUEST' | 'EMPLOYEE' | 'all' | undefined;
  if (
    query.memberType === 'INTERNAL' ||
    query.memberType === 'EXTERNAL_GUEST' ||
    query.memberType === 'EMPLOYEE' ||
    query.memberType === 'all'
  ) {
    memberType = query.memberType;
  } else if (query.include === 'guests') {
    memberType = 'all';
  }

  const params = {
    cursor: query.cursor,
    limit: query.limit ? parseInt(query.limit, 10) : 25,
    search: query.search,
    status: query.status,
    memberType,
  };

  try {
    const result = await membersService.listMembers(db, params);
    const projected = result.data.map((member) =>
      membersService.projectMemberFields(member as Record<string, unknown>, visibility, viewerUserId),
    );
    return list(c, projected, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/team-members] list failed:', err);
    return error.internal(c, 'Failed to fetch members');
  }
});

// ===========================================================================
// Sync — reconcile tenant DB against Clerk org state
// ===========================================================================

/**
 * POST /sync — safety-net reconciliation against Clerk org state. Webhooks
 * are the primary mechanism; this endpoint catches any that were missed.
 *
 * - ACTIVE members whose clerkMembershipId is no longer in Clerk → soft-delete
 * - PENDING members whose clerkInvitationId is no longer pending → soft-delete
 */
app.post('/sync', requirePermission('team:read'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const base = `https://api.clerk.com/v1/organizations/${orgId}`;
  const headers = { Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` };

  try {
    const [membershipsResp, invitationsResp] = await Promise.all([
      fetch(`${base}/memberships?limit=500`, { headers }),
      fetch(`${base}/invitations?status=pending&limit=500`, { headers }),
    ]);

    if (!membershipsResp.ok || !invitationsResp.ok) {
      console.error('[app-api/team-members] sync Clerk API error:', membershipsResp.status, invitationsResp.status);
      return error.internal(c, 'Failed to fetch data from Clerk');
    }

    const [membershipsData, invitationsData] = await Promise.all([
      membershipsResp.json() as Promise<{ data: Array<{ id: string }> }>,
      invitationsResp.json() as Promise<{ data: Array<{ id: string }> }>,
    ]);

    const { workspaceMembers } = schema;
    const clerkMembershipIds = membershipsData.data.map((m) => m.id);
    const clerkInvitationIds = invitationsData.data.map((i) => i.id);

    // Soft-delete ACTIVE members whose clerkMembershipId is no longer in Clerk.
    // Only touches rows that have a clerkMembershipId — OWNER rows provisioned
    // without going through Clerk are left intact.
    if (clerkMembershipIds.length > 0) {
      await db
        .update(workspaceMembers)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(workspaceMembers.status, 'ACTIVE'),
            isNull(workspaceMembers.deletedAt),
            isNotNull(workspaceMembers.clerkMembershipId),
            notInArray(workspaceMembers.clerkMembershipId, clerkMembershipIds),
          ),
        );
    }

    // Soft-delete PENDING members whose clerkInvitationId is no longer pending.
    if (clerkInvitationIds.length > 0) {
      await db
        .update(workspaceMembers)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(workspaceMembers.status, 'PENDING'),
            isNull(workspaceMembers.deletedAt),
            isNotNull(workspaceMembers.clerkInvitationId),
            notInArray(workspaceMembers.clerkInvitationId, clerkInvitationIds),
          ),
        );
    } else {
      // No pending invitations in Clerk — clean up all PENDING rows with a clerkInvitationId.
      await db
        .update(workspaceMembers)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(workspaceMembers.status, 'PENDING'),
            isNull(workspaceMembers.deletedAt),
            isNotNull(workspaceMembers.clerkInvitationId),
          ),
        );
    }

    return success(c, { synced: true });
  } catch (err) {
    console.error('[app-api/team-members] sync failed:', err);
    return error.internal(c, 'Failed to sync team from Clerk');
  }
});

// ===========================================================================
// Manage — invite / role change / remove (keeps Clerk org in sync)
// ===========================================================================

type InviteRole = { roleName: string; resolvedRoleId: string | null };
type InviteMemberType = 'INTERNAL' | 'EXTERNAL_GUEST' | 'EMPLOYEE';

/**
 * Resolve role. Returns null when the requested role does not exist.
 *
 * Guests and EMPLOYEE members don't take a role. Guests land on VIEWER with a
 * fixed permissions allowlist. An EMPLOYEE member's access is the fixed
 * EMPLOYEE_MEMBER_PERMISSIONS set (the permission resolver ignores their
 * role); VIEWER is stored so the row still carries the lowest tier.
 */
async function resolveInviteRole(
  db: Database,
  memberType: InviteMemberType,
  roleId: string | undefined | null,
): Promise<InviteRole | null> {
  if (memberType !== 'INTERNAL') return { roleName: 'VIEWER', resolvedRoleId: null };
  if (!roleId) return { roleName: 'MEMBER', resolvedRoleId: null };
  const role = await lookupRole(db, roleId);
  if (!role) return null;
  return { roleName: role.name.toUpperCase(), resolvedRoleId: roleId };
}

/**
 * Seat check for internal invites. Returns the user-facing message when the
 * workspace is at its seat limit, otherwise null. When there is room, Clerk's
 * cap is first raised to match the plan, so a stale cap left by a plan change
 * outside billing can't refuse a seat the plan has. A failed lookup never
 * blocks an invite — Clerk is still the hard gate behind this.
 */
async function checkSeatsForInvite(env: Env, orgId: string): Promise<string | null> {
  let seats: SeatLimit | null;
  try {
    seats = await getWorkspaceSeatLimit(env, orgId);
  } catch (err) {
    console.error('[app-api/team-members] Seat-limit check failed, continuing:', err);
    return null;
  }
  if (!seats) return null;
  if (seats.atLimit) {
    return `Your ${seats.planName} plan includes ${seats.limit} ${seats.limit === 1 ? 'member' : 'members'}. Upgrade your plan to invite more people.`;
  }
  await alignClerkCapWithPlan(env, orgId, seats.limit);
  return null;
}

type ClerkErrorBody = {
  errors?: Array<{ code?: string; message?: string; long_message?: string }>;
};

/**
 * Clerk Backend API error codes for "create organization membership" (see
 * https://clerk.com/docs/guides/development/errors/backend-api):
 * `organization_membership_quota_exceeded` (403) and
 * `already_a_member_in_organization` (400).
 */
const CLERK_MEMBERSHIP_QUOTA_CODES = ['organization_membership_quota_exceeded', 'max_allowed_memberships'];
const CLERK_ALREADY_MEMBER_CODE = 'already_a_member_in_organization';

type GuestDirectAddResult =
  | { status: 'none' }
  | { status: 'failed'; httpStatus: number; code?: string; message?: string }
  | { status: 'added'; memberId: string };

export type GuestAddFailure = Extract<GuestDirectAddResult, { status: 'failed' }>;

/**
 * Map a failed direct guest add to the API error. Known Clerk codes get a
 * specific answer; anything else keeps the generic error but passes Clerk's
 * own message through so the failure is diagnosable from the response.
 */
export function describeGuestAddFailure(failure: GuestAddFailure): {
  kind: 'forbidden' | 'conflict' | 'internal';
  message: string;
} {
  const code = failure.code ?? '';
  if (CLERK_MEMBERSHIP_QUOTA_CODES.some((known) => code.includes(known))) {
    return {
      kind: 'forbidden',
      message:
        "This workspace's member limit prevents adding this guest. Upgrade your plan or remove a member or pending invitation, then try again.",
    };
  }
  if (code === CLERK_ALREADY_MEMBER_CODE) {
    return { kind: 'conflict', message: 'This person is already a member of this workspace.' };
  }
  const base = 'Failed to add guest to Clerk organization';
  return { kind: 'internal', message: failure.message ? `${base}: ${failure.message}` : base };
}

/**
 * The `max_allowed_memberships` Clerk needs for one more membership to fit, or
 * null when it already fits (or the organization has no cap).
 */
export function clerkCapWithRoomForOne(cap: number | null | undefined, occupied: number): number | null {
  if (!cap || cap <= 0) return null;
  return occupied < cap ? null : occupied + 1;
}

/** `total_count` of a Clerk list endpoint, or null when it can't be read. */
async function clerkListTotal(secretKey: string, url: string): Promise<number | null> {
  const res = await fetch(url, { headers: clerkHeaders(secretKey) });
  if (!res.ok) return null;
  const body = (await res.json()) as { total_count?: number };
  return typeof body.total_count === 'number' ? body.total_count : null;
}

/**
 * Guests don't use a paid seat, but Clerk's `max_allowed_memberships` (billing
 * sets it to the paid seat limit) counts every membership and pending
 * invitation, guests included, so on a one-seat plan no guest could ever be
 * added. When the organization is full, raise the cap by one before adding
 * a guest. Internal invites never come here: they are checked against the
 * paid seats instead. Best effort: if Clerk can't be read the add still runs
 * and Clerk's own answer is reported as before.
 */
async function makeClerkRoomForGuest(env: Env, orgId: string): Promise<void> {
  try {
    const base = `https://api.clerk.com/v1/organizations/${orgId}`;
    const orgRes = await fetch(base, { headers: clerkHeaders(env.CLERK_SECRET_KEY) });
    if (!orgRes.ok) return;
    const org = (await orgRes.json()) as { max_allowed_memberships?: number | null };
    if (!org.max_allowed_memberships || org.max_allowed_memberships <= 0) return;

    const [members, pending] = await Promise.all([
      clerkListTotal(env.CLERK_SECRET_KEY, `${base}/memberships?limit=1`),
      clerkListTotal(env.CLERK_SECRET_KEY, `${base}/invitations?status=pending&limit=1`),
    ]);
    if (members === null) return;
    const nextCap = clerkCapWithRoomForOne(org.max_allowed_memberships, members + (pending ?? 0));
    if (nextCap !== null) await syncClerkSeatLimit(env.CLERK_SECRET_KEY, orgId, nextCap);
  } catch (err) {
    console.error('[app-api/team-members] Could not make room for a guest in Clerk:', err);
  }
}

/**
 * For guests: try to short-circuit the email-invitation by adding the
 * existing Clerk user directly to the org. This is what makes "one
 * identity, many workspaces" work.
 */
async function addExistingClerkUserAsGuest(params: {
  env: Env;
  db: Database;
  orgId: string;
  invitingUserId: string;
  email: string;
  name: string;
  clerkRole: 'org:admin' | 'org:member';
}): Promise<GuestDirectAddResult> {
  const { env, db, orgId, invitingUserId, email, name, clerkRole } = params;
  const existingClerkUserId = await findClerkUserIdByEmail(env.CLERK_SECRET_KEY, email);
  if (!existingClerkUserId) return { status: 'none' };

  const membershipResp = await fetch(
    `https://api.clerk.com/v1/organizations/${orgId}/memberships`,
    {
      method: 'POST',
      headers: clerkHeaders(env.CLERK_SECRET_KEY),
      body: JSON.stringify({
        user_id: existingClerkUserId,
        role: clerkRole,
        // public_metadata.member_type lets billing-worker exclude this
        // membership from the seat count without needing tenant DB access.
        public_metadata: { member_type: 'EXTERNAL_GUEST' },
      }),
    },
  );

  if (!membershipResp.ok) {
    const errBody = (await membershipResp.json().catch(() => ({}))) as ClerkErrorBody;
    console.error(
      '[app-api/team-members] Clerk membership error (guest):',
      membershipResp.status,
      logSafe(JSON.stringify(errBody)),
    );
    const clerkError = errBody?.errors?.[0];
    return {
      status: 'failed',
      httpStatus: membershipResp.status,
      code: clerkError?.code,
      message: clerkError?.long_message ?? clerkError?.message,
    };
  }

  const membership = (await membershipResp.json()) as { id: string };

  const memberId = generateId('mbr');
  await db.insert(schema.workspaceMembers).values({
    id: memberId,
    userId: existingClerkUserId,
    email: email.toLowerCase(),
    name,
    role: 'VIEWER',
    roleId: null,
    permissions: GUEST_DEFAULT_PERMISSIONS,
    memberType: 'EXTERNAL_GUEST',
    status: 'ACTIVE',
    clerkMembershipId: membership.id,
    invitedBy: invitingUserId,
    invitedAt: new Date(),
    acceptedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { status: 'added', memberId };
}

type ClerkInvitationFailure = {
  kind: 'forbidden' | 'conflict' | 'internal';
  message: string;
};

/** Map a failed Clerk invitation response to the API error we return. */
async function describeClerkInvitationFailure(resp: Response): Promise<ClerkInvitationFailure> {
  const errBody = (await resp.json().catch(() => ({}))) as ClerkErrorBody;
  const clerkCode = errBody?.errors?.[0]?.code;
  // Backstop for the seat cap: the pre-flight check normally catches this, but
  // it is skipped when the lookup fails and can race a concurrent invite.
  // Clerk is the authority either way.
  if (clerkCode?.includes('quota') || clerkCode?.includes('max_allowed_memberships')) {
    return {
      kind: 'forbidden',
      message:
        'Your plan has no seats left. Upgrade your plan, or remove a member or pending invitation, then try again.',
    };
  }
  if (clerkCode === 'duplicate_record' || resp.status === 422) {
    return { kind: 'conflict', message: 'An invitation for this email already exists in Clerk.' };
  }
  console.error(
    '[app-api/team-members] Clerk invitation error:',
    resp.status,
    logSafe(JSON.stringify(errBody)),
  );
  return { kind: 'internal', message: 'Failed to create Clerk invitation' };
}

/**
 * Check for an existing member / pending invitation for this email. Returns
 * the conflict message, or null when the address is free to invite.
 */
async function getExistingMemberConflict(db: Database, email: string): Promise<string | null> {
  const { workspaceMembers } = schema;
  const [existing] = await db
    .select({ id: workspaceMembers.id, status: workspaceMembers.status })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.email, email.toLowerCase()),
        isNull(workspaceMembers.deletedAt),
      ),
    )
    .limit(1);

  if (existing?.status === 'ACTIVE') {
    return 'This email address is already a member of this workspace.';
  }
  if (existing?.status === 'PENDING') {
    return 'An invitation has already been sent to this email address.';
  }
  return null;
}

/**
 * Create the Clerk org invitation. For guests, the invitation is tagged so the
 * resulting membership can be identified as external.
 */
async function createClerkInvitation(
  env: Env,
  orgId: string,
  email: string,
  clerkRole: 'org:admin' | 'org:member',
  isGuest: boolean,
): Promise<{ id: string } | { failure: ClerkInvitationFailure }> {
  const resp = await fetch(`https://api.clerk.com/v1/organizations/${orgId}/invitations`, {
    method: 'POST',
    headers: clerkHeaders(env.CLERK_SECRET_KEY),
    body: JSON.stringify({
      email_address: email,
      role: clerkRole,
      ...(isGuest ? { public_metadata: { member_type: 'EXTERNAL_GUEST' } } : {}),
    }),
  });

  if (!resp.ok) {
    return { failure: await describeClerkInvitationFailure(resp) };
  }
  const invitation = (await resp.json()) as { id: string };
  return { id: invitation.id };
}

/** Insert the PENDING member row that mirrors a freshly created Clerk invitation. */
async function insertPendingMember(
  db: Database,
  input: {
    email: string;
    name: string;
    roleName: string;
    resolvedRoleId: string | null;
    memberType: InviteMemberType;
    isGuest: boolean;
    clerkInvitationId: string;
    invitingUserId: string;
  },
): Promise<string> {
  const memberId = generateId('mbr');
  await db.insert(schema.workspaceMembers).values({
    id: memberId,
    userId: `invited_${input.email}`,
    email: input.email.toLowerCase(),
    name: input.name,
    role:
      input.roleName === 'OWNER' ? 'MEMBER' : (input.roleName as 'ADMIN' | 'MEMBER' | 'VIEWER'),
    roleId: input.resolvedRoleId,
    permissions: input.isGuest ? GUEST_DEFAULT_PERMISSIONS : [],
    memberType: input.memberType,
    status: 'PENDING',
    clerkInvitationId: input.clerkInvitationId,
    invitedBy: input.invitingUserId,
    invitedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return memberId;
}

app.post('/invite', async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const invitingUserId = c.get('userId');
  if (!orgId) return error.orgRequired(c);

  let body: ReturnType<typeof inviteMemberSchema.parse>;
  try {
    body = inviteMemberSchema.parse(await c.req.json());
  } catch {
    return error.badRequest(c, 'Invalid request body');
  }

  const { email, name, roleId, memberType = 'INTERNAL' } = body;
  const isGuest = memberType === 'EXTERNAL_GUEST';

  // Permission gate: guests use a separate permission so admins can grant
  // "invite externals" to roles that can't invite internal teammates.
  // EMPLOYEE members take a paid seat like teammates, so `team:create`.
  const requiredPermission = isGuest ? 'team:invite_external' : 'team:create';
  if (!(await hasContextPermission(c, requiredPermission))) {
    return error.forbidden(c, `Missing required permission: ${requiredPermission}`);
  }

  const inviteRole = await resolveInviteRole(db, memberType, roleId);
  if (!inviteRole) return error.notFound(c, 'Role', roleId ?? '');
  const { roleName, resolvedRoleId } = inviteRole;

  const clerkRole = mapRoleToClerk(roleName);

  const conflictMessage = await getExistingMemberConflict(db, email);
  if (conflictMessage) return error.conflict(c, conflictMessage);

  // Seat check, internal and EMPLOYEE members — guests are tagged EXTERNAL_GUEST
  // and excluded from the seat count, so they never consume one. Clerk enforces
  // the same cap via max_allowed_memberships and would reject this anyway;
  // checking first turns a generic 500 into an answer the UI can act on,
  // which matters most on Free, where the cap is a single seat. With room left,
  // the check also brings a stale Clerk cap up to the plan.
  const seatLimitMessage = isGuest ? null : await checkSeatsForInvite(c.env, orgId);
  if (seatLimitMessage) return error.forbidden(c, seatLimitMessage);
  if (isGuest) await makeClerkRoomForGuest(c.env, orgId);

  const direct: GuestDirectAddResult = isGuest
    ? await addExistingClerkUserAsGuest({
        env: c.env,
        db,
        orgId,
        invitingUserId,
        email,
        name,
        clerkRole,
      })
    : { status: 'none' };
  if (direct.status === 'failed') {
    const failure = describeGuestAddFailure(direct);
    return error[failure.kind](c, failure.message);
  }
  if (direct.status === 'added') {
    return success(
      c,
      { memberId: direct.memberId, memberType: 'EXTERNAL_GUEST', activated: true },
      201,
    );
  }

  // Standard path: Clerk org invitation (sends email).
  const invitation = await createClerkInvitation(c.env, orgId, email, clerkRole, isGuest);
  if ('failure' in invitation) {
    return error[invitation.failure.kind](c, invitation.failure.message);
  }

  // Insert PENDING member record. memberType is preserved through to the
  // accept handler.
  const memberId = await insertPendingMember(db, {
    email,
    name,
    roleName,
    resolvedRoleId,
    memberType,
    isGuest,
    clerkInvitationId: invitation.id,
    invitingUserId,
  });

  return success(c, { memberId, memberType, activated: false }, 201);
});

// ===========================================================================
// Read — single member by id (must stay below literal-segment routes)
// ===========================================================================

app.get('/:id', async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const visibility = await getVisibility(c);
  const memberId = c.req.param('id');

  try {
    const member = await membersService.getMember(db, memberId);
    if (!member) return error.notFound(c, 'Member', memberId);
    const projected = membersService.projectMemberFields(
      member as Record<string, unknown>,
      visibility,
      viewerUserId,
    );
    return success(c, projected);
  } catch (err) {
    console.error('[app-api/team-members] get failed:', err);
    return error.internal(c, 'Failed to fetch member');
  }
});

type MemberRoleChange =
  | { tier: 'ADMIN' | 'MEMBER' | 'VIEWER'; roleIdValue: string | null }
  | { missingRoleId: string };

/**
 * Resolve the system tier written to `role` and the custom-role id written to
 * `roleId`. At most one of `role` / `roleId` is present (enforced by the
 * schema). `role` is always a valid tier; a custom role maps onto a tier via
 * its name and otherwise falls back to MEMBER — never write a long
 * custom-role name into the varchar `role` column.
 */
async function resolveMemberRoleChange(
  db: Database,
  body: ReturnType<typeof updateMemberInput.parse>,
): Promise<MemberRoleChange> {
  if (!body.roleId) {
    return { tier: body.role!, roleIdValue: null };
  }
  const role = await lookupRole(db, body.roleId);
  if (!role) return { missingRoleId: body.roleId };
  const name = role.name.toUpperCase();
  const tier = name === 'ADMIN' || name === 'VIEWER' ? name : 'MEMBER';
  return { tier, roleIdValue: body.roleId };
}

/** Push a role change to the Clerk org membership. Returns false on failure. */
async function updateClerkMembershipRole(
  env: Env,
  orgId: string,
  clerkMembershipId: string,
  tier: 'ADMIN' | 'MEMBER' | 'VIEWER',
): Promise<boolean> {
  const resp = await fetch(
    `https://api.clerk.com/v1/organizations/${orgId}/memberships/${clerkMembershipId}`,
    {
      method: 'PATCH',
      headers: clerkHeaders(env.CLERK_SECRET_KEY),
      body: JSON.stringify({ role: mapRoleToClerk(tier) }),
    },
  );
  if (!resp.ok) {
    console.error('[app-api/team-members] Clerk role update failed:', resp.status);
    return false;
  }
  return true;
}

/** Only the optional member fields the caller actually sent. */
function pickMemberFieldUpdates(
  body: ReturnType<typeof updateMemberInput.parse>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (body.name !== undefined) fields.name = body.name;
  if (body.permissions !== undefined) fields.permissions = body.permissions;
  if (body.permissionDenies !== undefined) fields.permissionDenies = body.permissionDenies;
  if (body.hoursPerWeek !== undefined) fields.hoursPerWeek = body.hoursPerWeek;
  return fields;
}

/**
 * PATCH /:id — update a member: role (Clerk + DB), display name, per-member
 * permission overrides, contracted hours.
 *
 * Ported up to parity with api-worker `PUT /settings/members/:memberId`, which
 * accepted `name` / `permissions` / `hoursPerWeek` alongside the role. The
 * role half is unchanged from the original app-api handler (Clerk sync, tier
 * resolution, OWNER lock).
 *
 * A role change is OPTIONAL here: the team-member panel writes only
 * `permissions` or only `hoursPerWeek`, so the Clerk round-trip and the
 * ACTIVE-status guard only apply when a role is actually being changed.
 */
app.patch('/:id', requirePermission('team:update'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const memberId = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  let body: ReturnType<typeof updateMemberInput.parse>;
  try {
    body = updateMemberInput.parse(await c.req.json());
  } catch {
    return error.badRequest(c, 'Invalid request body');
  }

  const { workspaceMembers } = schema;

  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  if (!member) return error.notFound(c, 'Member', memberId);

  const update: Record<string, unknown> = { updatedAt: new Date() };
  const changingRole = Boolean(body.role || body.roleId);

  if (changingRole) {
    // Hard owner lock: the workspace OWNER can never be demoted via this
    // endpoint. This also guarantees the workspace always retains its owner
    // (the last-owner invariant) since ownership can't be reassigned here.
    if (member.role === 'OWNER') {
      return error.forbidden(c, 'Cannot change the role of the workspace owner.');
    }
    if (member.status !== 'ACTIVE') {
      return error.badRequest(c, 'Can only update role of an active member.');
    }
    // An EMPLOYEE member's access is fixed (My HR + WeldChat); a role would
    // not apply and would still raise their Clerk org role.
    if (member.memberType === 'EMPLOYEE') {
      return error.badRequest(c, 'Employee members have fixed access and no role. Invite them as a team member to give them a role.');
    }

    const change = await resolveMemberRoleChange(db, body);
    if ('missingRoleId' in change) return error.notFound(c, 'Role', change.missingRoleId);
    const { tier, roleIdValue } = change;

    if (
      member.clerkMembershipId &&
      !(await updateClerkMembershipRole(c.env, orgId, member.clerkMembershipId, tier))
    ) {
      return error.internal(c, 'Failed to update role in Clerk');
    }

    update.role = tier;
    update.roleId = roleIdValue;
  }

  Object.assign(update, pickMemberFieldUpdates(body));

  await db.update(workspaceMembers).set(update).where(eq(workspaceMembers.id, memberId));

  return success(c, { id: memberId });
});

// DELETE /:id — remove member or cancel invitation (Clerk + DB)
app.delete('/:id', requirePermission('team:delete'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const memberId = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  const { workspaceMembers } = schema;

  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  if (!member) return error.notFound(c, 'Member', memberId);
  if (member.role === 'OWNER') return error.forbidden(c, 'Cannot remove the workspace owner.');

  const headers = clerkHeaders(c.env.CLERK_SECRET_KEY);

  if (member.status === 'ACTIVE' && member.clerkMembershipId) {
    const resp = await fetch(
      `https://api.clerk.com/v1/organizations/${orgId}/memberships/${member.clerkMembershipId}`,
      { method: 'DELETE', headers },
    );
    if (!resp.ok && resp.status !== 404) {
      console.error('[app-api/team-members] Clerk membership delete failed:', resp.status);
      return error.internal(c, 'Failed to remove member from Clerk organization');
    }
  }

  if (member.status === 'PENDING' && member.clerkInvitationId) {
    const resp = await fetch(
      `https://api.clerk.com/v1/organizations/${orgId}/invitations/${member.clerkInvitationId}/revoke`,
      { method: 'POST', headers, body: JSON.stringify({}) },
    );
    if (!resp.ok && resp.status !== 404) {
      console.error('[app-api/team-members] Clerk invitation revoke failed:', resp.status);
      return error.internal(c, 'Failed to revoke invitation in Clerk');
    }
  }

  await db
    .update(workspaceMembers)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceMembers.id, memberId));

  return noContent(c);
});

// POST /:id/resend-invite — revoke old Clerk invitation + create new one
app.post('/:id/resend-invite', requirePermission('team:update'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const memberId = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  const { workspaceMembers } = schema;

  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  if (!member) return error.notFound(c, 'Member', memberId);
  if (member.status !== 'PENDING') return error.badRequest(c, 'Can only resend invite to a pending member.');
  if (!member.email) return error.badRequest(c, 'Pending member has no email address.');

  const headers = clerkHeaders(c.env.CLERK_SECRET_KEY);
  const clerkRole = mapRoleToClerk(member.role);

  // Revoke the old invitation (best-effort, ignore 404)
  if (member.clerkInvitationId) {
    await fetch(
      `https://api.clerk.com/v1/organizations/${orgId}/invitations/${member.clerkInvitationId}/revoke`,
      { method: 'POST', headers, body: JSON.stringify({}) },
    ).catch(() => {});
  }

  // Create a fresh invitation
  const newInviteResp = await fetch(
    `https://api.clerk.com/v1/organizations/${orgId}/invitations`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ email_address: member.email, role: clerkRole }),
    },
  );

  if (!newInviteResp.ok) {
    console.error('[app-api/team-members] Clerk resend-invite failed:', newInviteResp.status);
    return error.internal(c, 'Failed to resend invitation via Clerk');
  }

  const newInvite = (await newInviteResp.json()) as { id: string };

  // deletedAt: null restores the record even if the organizationInvitation.revoked
  // webhook soft-deleted it during the brief window between revoke and this update.
  await db
    .update(workspaceMembers)
    .set({ clerkInvitationId: newInvite.id, invitedAt: new Date(), updatedAt: new Date(), deletedAt: null })
    .where(eq(workspaceMembers.id, memberId));

  return success(c, { success: true });
});

// ===========================================================================
// Per-member access — permissions breakdown + app assignments
//
// Ported from api-worker /settings/members/:memberId/{permissions,apps,
// apps/toggle} (W5b). Gating is legacy-identical, and correct rather than
// merely faithful:
//   - the two reads sit at `team:read`, which SYSTEM_ROLES.MEMBER carries via
//     `settings:team:read`. That matters beyond the settings screen: WeldChat
//     opens the same panel with context="settings" for any user viewing a DM
//     or profile, so both queries fire for plain members.
//   - the toggle sits at `team:update` (OWNER/ADMIN). It edits *another*
//     member's app access — not a self-scoped action — and the panel already
//     disables the control unless `canManageMembers`, which WeldChat passes as
//     false. So no member-tier user can reach it.
//
// api-worker's PUT /:memberId/apps (bulk replace) is NOT ported: its only
// client was an unexported, never-referenced hook in the platform's
// use-settings-queries.ts, deleted in this pass. Nothing calls it.
// ===========================================================================

// GET /:id/permissions — role-derived vs per-member override breakdown
app.get('/:id/permissions', requirePermission('team:read'), async (c) => {
  const db = c.get('tenantDb');
  const memberId = c.req.param('id');

  try {
    const breakdown = await memberAccessService.getMemberPermissions(db, memberId);
    if (!breakdown) return error.notFound(c, 'Member', memberId);
    return success(c, breakdown);
  } catch (err) {
    console.error('[app-api/team-members] get member permissions failed:', err);
    return error.internal(c, 'Failed to fetch member permissions');
  }
});

// GET /:id/apps — workspace-installed apps + this member's assignment status
app.get('/:id/apps', requirePermission('team:read'), async (c) => {
  const db = c.get('tenantDb');
  const memberId = c.req.param('id');

  try {
    const apps = await memberAccessService.getMemberApps(db, memberId);
    if (!apps) return error.notFound(c, 'Member', memberId);
    return success(c, apps);
  } catch (err) {
    console.error('[app-api/team-members] get member apps failed:', err);
    return error.internal(c, 'Failed to fetch member apps');
  }
});

// POST /:id/apps/toggle — grant/revoke a single app for a member
app.post(
  '/:id/apps/toggle',
  requirePermission('team:update'),
  zValidator('json', toggleMemberAppSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const actorUserId = c.get('userId');
    const memberId = c.req.param('id');
    const { appCode, enabled } = c.req.valid('json');

    try {
      const ok = await memberAccessService.toggleMemberApp(db, {
        memberId,
        appCode,
        enabled,
        actorUserId,
      });
      if (!ok) return error.notFound(c, 'Member', memberId);
      return success(c, { appCode, enabled });
    } catch (err) {
      console.error('[app-api/team-members] toggle member app failed:', err);
      return error.internal(c, 'Failed to toggle member app');
    }
  },
);

// ===========================================================================
// Profile / notes / common / activity — under /user/:userId/*
//
// These check permissions conditionally (self-or-admin), so resolve the
// viewer's permissions once per matching request.
// ===========================================================================

app.use('/user/*', async (c, next) => {
  await ensurePermissionsLoaded(c);
  await next();
});

// GET /user/:userId/profile
app.get('/user/:userId/profile', async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const subjectUserId = c.req.param('userId');

  try {
    const profile = await profileService.getMemberProfile(db, subjectUserId, {
      userId: viewerUserId,
      isAdmin: viewerIsAdmin(c),
    });
    if (!profile) return error.notFound(c, 'Member', subjectUserId);
    return success(c, profile);
  } catch (err) {
    console.error('[app-api/team-members] profile get failed:', err);
    return error.internal(c, 'Failed to fetch profile');
  }
});

// PATCH /user/:userId/profile
app.patch('/user/:userId/profile', zValidator('json', updateMemberProfileInput), async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const subjectUserId = c.req.param('userId');
  const patch = c.req.valid('json');

  try {
    const profile = await profileService.updateMemberProfile(
      db,
      subjectUserId,
      { userId: viewerUserId, isAdmin: viewerIsAdmin(c) },
      patch,
    );
    if (!profile) return error.notFound(c, 'Member', subjectUserId);
    return success(c, profile);
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN') return error.forbidden(c);
    console.error('[app-api/team-members] profile update failed:', err);
    return error.internal(c, 'Failed to update profile');
  }
});

// GET /user/:userId/notes — viewer's own private note
app.get('/user/:userId/notes', async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const subjectUserId = c.req.param('userId');

  try {
    const note = await notesService.getMyNoteFor(db, viewerUserId, subjectUserId);
    return success(c, note);
  } catch (err) {
    console.error('[app-api/team-members] notes get failed:', err);
    return error.internal(c, 'Failed to fetch note');
  }
});

// PUT /user/:userId/notes
app.put('/user/:userId/notes', zValidator('json', memberNoteInput), async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const subjectUserId = c.req.param('userId');
  const { body } = c.req.valid('json');

  try {
    const note = await notesService.upsertMyNote(db, viewerUserId, subjectUserId, body);
    return success(c, note);
  } catch (err) {
    console.error('[app-api/team-members] notes upsert failed:', err);
    return error.internal(c, 'Failed to save note');
  }
});

// DELETE /user/:userId/notes
app.delete('/user/:userId/notes', async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const subjectUserId = c.req.param('userId');

  try {
    await notesService.deleteMyNote(db, viewerUserId, subjectUserId);
    return noContent(c);
  } catch (err) {
    console.error('[app-api/team-members] notes delete failed:', err);
    return error.internal(c, 'Failed to delete note');
  }
});

// GET /user/:userId/common?categories=channels,projects,...
app.get('/user/:userId/common', zValidator('query', commonConceptsQuery), async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const subjectUserId = c.req.param('userId');
  const { categories } = c.req.valid('query');

  if (viewerUserId === subjectUserId) {
    return success(c, { channels: [], projects: [], tasks: [], crm: [], helpdesk: [] });
  }

  try {
    const result = await commonService.getCommonConcepts(db, viewerUserId, subjectUserId, categories);
    return success(c, result);
  } catch (err) {
    console.error('[app-api/team-members] common failed:', err);
    return error.internal(c, 'Failed to fetch common concepts');
  }
});

// GET /user/:userId/activity — admin-only (or self)
app.get('/user/:userId/activity', zValidator('query', listMemberActivityQuery), async (c) => {
  const db = c.get('tenantDb');
  const viewerUserId = c.get('userId');
  const subjectUserId = c.req.param('userId');

  if (!viewerCanReadMemberActivity(c, viewerUserId, subjectUserId)) {
    return error.forbidden(c);
  }

  const params = c.req.valid('query');

  try {
    const result = await activityService.listMemberActivity(db, subjectUserId, params);
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/team-members] activity failed:', err);
    return error.internal(c, 'Failed to fetch activity');
  }
});

export const teamMembersRoutes = app;
