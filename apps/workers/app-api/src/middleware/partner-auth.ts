/**
 * Partner portal authentication (`/api/partner/*`).
 *
 * A partner user is a person, not a workspace member: they may have no active
 * org at all, so these routes sit before the global `apiAuth()` (like the
 * other org-less routers) and never get a tenant DB on the context. They act
 * on master data only.
 *
 * `partnerIdentity()` resolves the caller's partner memberships; `partnerAuth()`
 * additionally picks the partner to act for (header `X-Partner-Id`, required
 * when the user belongs to several) and sets `partner` + `partnerMember`.
 * `requirePartnerPermission()` then gates a route on `PARTNER_PERMISSIONS`.
 *
 * Invitations are by email. A pending `partner_members` row for one of the
 * user's emails is claimed on first use (`listPartnerMemberships`), so the
 * emails passed in must be ones the user has proven: master `users.email`
 * (synced from Clerk), else the verified addresses on the Clerk user.
 */

import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { listPartnerMemberships, memberCan, type ResolvedPartnerMember } from '@weldsuite/core-domain/partners';
import type { PartnerPermission } from '@weldsuite/app-api-client/schemas/partners';
import { getMasterDb, masterSchema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';

type PartnerEnv = { Bindings: Env; Variables: Variables };

/** How long "this user is not a partner" is remembered, so the shell's `/me` probe stays cheap. */
const NEGATIVE_CACHE_TTL_SECONDS = 60;
const negativeKey = (userId: string) => `partner-none:${userId}`;

/** Verified email addresses of a Clerk user (fallback when master has no row yet). */
async function fetchVerifiedClerkEmails(env: Env, userId: string): Promise<string[]> {
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    if (!res.ok) return [];
    const user = (await res.json()) as {
      email_addresses?: Array<{ email_address?: string; verification?: { status?: string } | null }>;
    };
    return (user.email_addresses ?? [])
      .filter((e) => e.verification?.status === 'verified' && e.email_address)
      .map((e) => e.email_address!);
  } catch (err) {
    console.warn('[partner-auth] Could not read the Clerk user emails:', err);
    return [];
  }
}

/**
 * The caller's partner memberships. `useNegativeCache` (the `/me` probe) skips
 * the database for a minute after a user turned out not to be a partner.
 */
export async function loadPartnerMemberships(
  env: Env,
  userId: string,
  opts: { useNegativeCache?: boolean } = {},
): Promise<ResolvedPartnerMember[]> {
  if (opts.useNegativeCache) {
    try {
      if (await env.WORKSPACE_CACHE.get(negativeKey(userId))) return [];
    } catch {
      // No cache (tests, local dev): fall through to the database.
    }
  }

  const masterDb = getMasterDb(env);
  const [row] = await masterDb
    .select({ email: masterSchema.users.email })
    .from(masterSchema.users)
    .where(eq(masterSchema.users.id, userId))
    .limit(1);
  const emails = row?.email ? [row.email] : await fetchVerifiedClerkEmails(env, userId);
  const memberships = await listPartnerMemberships(masterDb, { id: userId, emails });

  if (opts.useNegativeCache && memberships.length === 0) {
    try {
      await env.WORKSPACE_CACHE.put(negativeKey(userId), '1', { expirationTtl: NEGATIVE_CACHE_TTL_SECONDS });
    } catch {
      // Best effort.
    }
  }
  return memberships;
}

/** Resolve the caller's memberships without choosing a partner (`GET /me`). */
export const partnerIdentity = () =>
  createMiddleware<PartnerEnv>(async (c, next) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
    c.set('partnerMemberships', await loadPartnerMemberships(c.env, userId, { useNegativeCache: true }));
    await next();
  });

/** Resolve memberships and the partner to act for; sets `partner` + `partnerMember`. */
export const partnerAuth = () =>
  createMiddleware<PartnerEnv>(async (c, next) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);

    const memberships = await loadPartnerMemberships(c.env, userId);
    if (memberships.length === 0) {
      return c.json({ error: { code: 'NOT_A_PARTNER', message: 'You are not a member of any partner' } }, 403);
    }

    // `?partnerId=` is the fallback for a caller that cannot send the header.
    const requested = c.req.header('X-Partner-Id') ?? c.req.query('partnerId');
    let selected: ResolvedPartnerMember | undefined;
    if (requested) {
      selected = memberships.find((m) => m.partner.id === requested);
      if (!selected) {
        return c.json({ error: { code: 'NOT_A_PARTNER', message: 'You are not a member of this partner' } }, 403);
      }
    } else if (memberships.length === 1) {
      selected = memberships[0];
    } else {
      return c.json(
        { error: { code: 'PARTNER_REQUIRED', message: 'Send X-Partner-Id to choose the partner to act for' } },
        400,
      );
    }

    c.set('partnerMemberships', memberships);
    c.set('partner', selected!.partner);
    c.set('partnerMember', selected!);
    await next();
  });

/** Gate a route on a partner permission (`partner:workspaces:manage`, …). */
export const requirePartnerPermission = (permission: PartnerPermission) =>
  createMiddleware<PartnerEnv>(async (c, next) => {
    const member = c.get('partnerMember');
    if (!member || !memberCan(member, permission)) {
      return c.json({ error: { code: 'FORBIDDEN', message: `Missing required permission: ${permission}` } }, 403);
    }
    await next();
  });
