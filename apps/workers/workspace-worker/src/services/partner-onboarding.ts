/**
 * Partner-managed workspace onboarding (docs/plans/reseller-licensing.md).
 *
 * A partner creates a workspace for one of its customers from the partner
 * portal; app-api calls `WorkspaceOnboardEntrypoint.onboardPartnerWorkspace`
 * over the service binding. Compared with self-signup:
 *
 *  - the Clerk org is created WITHOUT a creator: the partner user is not a
 *    member and never sees customer data;
 *  - the customer's owner is invited by email (org:admin, tagged
 *    `weldRole: OWNER` so the Clerk webhook makes them the workspace OWNER);
 *  - the master row has `billingMode: 'partner'` + `partnerId` and a licence;
 *  - ProvisionWorkspaceWorkflow installs exactly the licensed apps, grants the
 *    licence's credits and skips Stripe.
 *
 * Re-running is safe: a retry within minutes resumes the workspace it created
 * (same partner and name), every master write is an upsert, and the owner
 * invitation is created only when no pending one exists for that email.
 */

import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { plans, workspaces } from '@weldsuite/db/schema/master';
import {
  LicenceError,
  assertPartnerOnboardAllowed,
  findRecentPartnerWorkspace,
  getPartner,
  registerPartnerWorkspace,
  type PartnerOnboardInput,
  type PartnerOnboardResult,
} from '@weldsuite/core-domain/partners';
import { licenceTermsSchema } from '@weldsuite/app-api-client/schemas/partners';
import type { Env } from '../index';
import { getMasterDb } from '../db';
import { isClerkSlugError, syncClerkSeatLimit } from '../lib/clerk';
import { withRandomSuffix } from '../lib/slug';
import { pickNewOrgSlug, resolveUniqueSlug } from '../routes/onboard';
import { provisionMailDomain } from './mail-provisioning';
import { provisionWorkspaceDatabase } from './provisioning';

const CLERK_API = 'https://api.clerk.com/v1';

/** Plan a partner workspace gets when its licence names no feature plan. */
const DEFAULT_PLAN_SLUG = 'free';

export const partnerOnboardInputSchema = z.object({
  partnerId: z.string().min(1).max(30),
  actorUserId: z.string().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase()),
  region: z.string().trim().max(50).optional(),
  ownerEmail: z.string().trim().email().max(255).transform((e) => e.toLowerCase()),
  licence: licenceTermsSchema.extend({ packageId: z.string().max(30).nullable().default(null) }),
});

/**
 * Failure of `onboardPartnerWorkspace`. Over the RPC boundary only the message
 * survives, so it starts with the code: `[INVALID_APPS] Unknown apps: x`.
 */
export class PartnerOnboardError extends Error {
  constructor(
    public readonly code:
      | 'VALIDATION'
      | 'INVALID_APPS'
      | 'PLAN_NOT_ALLOWED'
      | 'NO_CONTRACT'
      | 'NOT_FOUND'
      | 'WRONG_PARTNER'
      | 'CLERK_ORG_FAILED'
      | 'INVITE_FAILED'
      | 'PROVISIONING_FAILED',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'PartnerOnboardError';
  }
}

function clerkHeaders(env: Env) {
  return { Authorization: `Bearer ${env.CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' };
}

interface ClerkOrg {
  id: string;
  slug: string;
}

/**
 * Create the Clerk org with no creator and no members. Slug rejections retry
 * with a random suffix, then without a slug (Clerk picks one).
 */
async function createPartnerClerkOrg(
  env: Env,
  input: { name: string; slug: string; publicMetadata: Record<string, unknown>; privateMetadata: Record<string, unknown> },
): Promise<ClerkOrg> {
  const attempts: Array<string | undefined> = [input.slug, withRandomSuffix(input.slug), undefined];
  for (const slug of attempts) {
    const res = await fetch(`${CLERK_API}/organizations`, {
      method: 'POST',
      headers: clerkHeaders(env),
      body: JSON.stringify({
        name: input.name,
        public_metadata: input.publicMetadata,
        private_metadata: input.privateMetadata,
        ...(slug ? { slug } : {}),
      }),
    });
    if (res.ok) return (await res.json()) as ClerkOrg;
    const text = await res.text();
    if (slug !== undefined && isClerkSlugError(res.status, text)) {
      console.warn(`[PartnerOnboard] Clerk rejected slug "${slug}", retrying`);
      continue;
    }
    console.error('[PartnerOnboard] Failed to create Clerk org:', text);
    break;
  }
  throw new PartnerOnboardError('CLERK_ORG_FAILED', 'Could not create the workspace organization');
}

interface PendingOwnerInvite {
  email: string;
  invitedByName?: string | null;
}

/**
 * Invite the workspace owner if the org still carries the pending-invite marker
 * (Clerk private metadata `partnerOwnerInvite`), then clear the marker. Called
 * once the tenant database is ready, so the invitation webhook and the
 * membership webhook find the workspace; safe to call any number of times
 * (no marker, or an invitation already pending for the email, is a no-op).
 * Returns whether an invitation was sent now.
 */
export async function ensurePartnerOwnerInvited(env: Env, clerkOrgId: string): Promise<boolean> {
  const orgRes = await fetch(`${CLERK_API}/organizations/${clerkOrgId}`, { headers: clerkHeaders(env) });
  if (!orgRes.ok) {
    throw new PartnerOnboardError('INVITE_FAILED', `Could not read the organization (${orgRes.status})`);
  }
  const org = (await orgRes.json()) as { private_metadata?: { partnerOwnerInvite?: PendingOwnerInvite | null } };
  const pending = org.private_metadata?.partnerOwnerInvite;
  if (!pending?.email) return false;

  let sent = false;
  const listRes = await fetch(`${CLERK_API}/organizations/${clerkOrgId}/invitations?status=pending&limit=500`, {
    headers: clerkHeaders(env),
  });
  if (!listRes.ok) {
    throw new PartnerOnboardError('INVITE_FAILED', `Could not list invitations (${listRes.status})`);
  }
  const existing = (await listRes.json()) as { data?: Array<{ email_address?: string }> };
  const alreadyInvited = (existing.data ?? []).some(
    (i) => i.email_address?.toLowerCase() === pending.email.toLowerCase(),
  );

  if (!alreadyInvited) {
    const inviteRes = await fetch(`${CLERK_API}/organizations/${clerkOrgId}/invitations`, {
      method: 'POST',
      headers: clerkHeaders(env),
      body: JSON.stringify({
        email_address: pending.email,
        role: 'org:admin',
        // Read by the Clerk webhook: the invitee becomes the workspace OWNER and
        // the invitation email names the partner instead of "A teammate".
        public_metadata: { weldRole: 'OWNER', ...(pending.invitedByName ? { invitedByName: pending.invitedByName } : {}) },
      }),
    });
    if (!inviteRes.ok) {
      console.error('[PartnerOnboard] Owner invitation failed:', await inviteRes.text());
      throw new PartnerOnboardError('INVITE_FAILED', 'Could not invite the workspace owner');
    }
    sent = true;
  }

  // Merging `null` removes the key.
  const clearRes = await fetch(`${CLERK_API}/organizations/${clerkOrgId}/metadata`, {
    method: 'PATCH',
    headers: clerkHeaders(env),
    body: JSON.stringify({ private_metadata: { partnerOwnerInvite: null } }),
  });
  if (!clearRes.ok) {
    // The invitation exists; a repeat call sees it pending and only retries this.
    console.warn('[PartnerOnboard] Could not clear the owner-invite marker:', await clearRes.text());
  }
  return sent;
}

/** Map a thrown `LicenceError` onto the RPC error. */
function asOnboardError(err: unknown): never {
  if (err instanceof LicenceError) throw new PartnerOnboardError(err.code, err.message);
  throw err;
}

/**
 * Create a partner-managed workspace. Returns as soon as the workspace exists
 * and provisioning has been started (`ProvisionWorkspaceWorkflow`); the owner
 * is invited at once when the database is already usable (warm pool slot),
 * otherwise by the workflow right after the database is migrated.
 */
export async function onboardPartnerWorkspace(env: Env, rawInput: unknown): Promise<PartnerOnboardResult> {
  const parsed = partnerOnboardInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    console.error('[PartnerOnboard] Validation failed:', JSON.stringify(parsed.error.flatten()));
    throw new PartnerOnboardError('VALIDATION', 'Invalid workspace details');
  }
  const input: PartnerOnboardInput = parsed.data;
  const masterDb = getMasterDb(env);

  // Refuse before anything is created in Clerk.
  try {
    await assertPartnerOnboardAllowed(masterDb, input);
  } catch (err) {
    asOnboardError(err);
  }
  const partner = (await getPartner(masterDb, input.partnerId))!;

  // A retry resumes the workspace an earlier call created.
  const resumed = await findRecentPartnerWorkspace(masterDb, { partnerId: input.partnerId, name: input.name });

  let clerkOrgId: string;
  let slug: string;
  if (resumed) {
    clerkOrgId = resumed.clerkOrgId;
    slug = resumed.slug ?? (await pickNewOrgSlug(masterDb, input.name));
    console.log(`[PartnerOnboard] Resuming workspace ${resumed.id} for partner ${input.partnerId}`);
  } else {
    const orgSlug = await pickNewOrgSlug(masterDb, input.name);
    const org = await createPartnerClerkOrg(env, {
      name: input.name,
      slug: orgSlug,
      // `selectedApps` present = "created via onboarding": the Clerk
      // organization.created webhook then leaves provisioning to us.
      publicMetadata: {
        country: input.country,
        region: input.region,
        selectedApps: input.licence.allowedApps,
        partnerManaged: true,
      },
      // Server-only. `partnerOwnerInvite` is the pending-owner marker that
      // `ensurePartnerOwnerInvited` consumes.
      privateMetadata: {
        partnerId: input.partnerId,
        partnerOwnerInvite: { email: input.ownerEmail, invitedByName: partner.name },
      },
    });
    clerkOrgId = org.id;
    slug = await resolveUniqueSlug(masterDb, org.slug || orgSlug, org.id);
  }

  const [defaultPlan] = await masterDb
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.slug, DEFAULT_PLAN_SLUG), isNull(plans.deletedAt)))
    .limit(1);

  const { workspaceId } = await registerPartnerWorkspace(masterDb, {
    clerkOrgId,
    name: input.name,
    slug,
    partnerId: input.partnerId,
    actorUserId: input.actorUserId,
    licence: input.licence,
    defaultPlanId: defaultPlan?.id ?? null,
  });

  // Seat cap: the licence's, or none (0 removes Clerk's cap).
  await syncClerkSeatLimit(env.CLERK_SECRET_KEY, clerkOrgId, input.licence.maxSeats ?? 0);

  // No initialMember: nobody is a member yet, the owner joins by invitation.
  // selectedApps = the licensed apps (the workflow re-reads the licence).
  let ready = false;
  if (env.NEON_API_KEY) {
    const kickoff = await provisionWorkspaceDatabase(env, masterDb, workspaceId, input.name, {
      region: input.region,
      selectedApps: input.licence.allowedApps,
      slug,
      seedSampleData: false,
    });
    if (!kickoff.ok) {
      const message = kickoff.error ?? 'Provisioning failed to start';
      await masterDb
        .update(workspaces)
        .set({ provisioningStatus: 'failed', provisioningError: message.slice(0, 1000), updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
      // The workspace row exists, so a retry of this call resumes it.
      throw new PartnerOnboardError('PROVISIONING_FAILED', message);
    }
    ready = kickoff.ready === true;
  }

  if (env.CLOUDFLARE_API_TOKEN) {
    try {
      await provisionMailDomain(env, masterDb, workspaceId, slug);
    } catch (mailErr) {
      console.error('[PartnerOnboard] Mail domain provisioning failed (non-blocking):', mailErr);
    }
  }

  // Database already usable (warm pool slot): invite now. Otherwise the
  // workflow's invite-owner step does it once the database is migrated.
  if (ready) {
    try {
      await ensurePartnerOwnerInvited(env, clerkOrgId);
    } catch (err) {
      console.error('[PartnerOnboard] Owner invitation deferred to provisioning:', err);
    }
  }

  return { workspaceId, clerkOrgId };
}
