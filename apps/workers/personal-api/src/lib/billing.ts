/**
 * Clerk Billing entitlements for personal WeldMail.
 *
 * Plans/features are configured in the Clerk Dashboard (User Plans).
 * Session JWT claims carry plan/feature access after subscribe; we also
 * accept explicit plan/feature lists from verifyToken payload.
 *
 * Expected Clerk setup:
 *   - User Plan slug: `weldmail_pro`
 *   - Feature slug on that plan: `weldmail_pro` (optional; plan check is enough)
 */

export type PersonalPlan = 'free' | 'pro';

export interface PersonalEntitlements {
  plan: PersonalPlan;
  /** Max @weldmail.com addresses (v1: always 1). */
  maxAddresses: number;
  /** Soft daily outbound send cap. */
  dailySendLimit: number;
}

const FREE: PersonalEntitlements = {
  plan: 'free',
  maxAddresses: 1,
  dailySendLimit: 50,
};

const PRO: PersonalEntitlements = {
  plan: 'pro',
  maxAddresses: 1,
  dailySendLimit: 500,
};

/** Plan / feature slugs to treat as Pro. */
const PRO_PLAN_SLUGS = new Set(['weldmail_pro', 'pro']);
const PRO_FEATURE_SLUGS = new Set(['weldmail_pro', 'pro']);

/**
 * Resolve entitlements from a verified Clerk JWT payload.
 * Clerk Billing embeds plans/features in session claims (pla / fea).
 */
export function entitlementsFromClerkClaims(payload: Record<string, unknown>): PersonalEntitlements {
  if (hasProAccess(payload)) return PRO;
  return FREE;
}

function hasProAccess(payload: Record<string, unknown>): boolean {
  // Feature claim — often `fea` as string like "u:weldmail_pro" or comma-separated.
  const fea = payload.fea;
  if (typeof fea === 'string') {
    const parts = fea.split(/[,\s]+/).map((p) => p.replace(/^[uo]:/, '').toLowerCase());
    if (parts.some((p) => PRO_FEATURE_SLUGS.has(p))) return true;
  }

  // Plan claim — shape varies; handle common forms.
  const pla = payload.pla;
  if (typeof pla === 'string') {
    const parts = pla.split(/[,\s]+/).map((p) => p.replace(/^[uo]:/, '').toLowerCase());
    if (parts.some((p) => PRO_PLAN_SLUGS.has(p))) return true;
  }
  if (pla && typeof pla === 'object') {
    const obj = pla as Record<string, unknown>;
    const lists = [obj.u, obj.o, obj.plans, obj.user].filter(Array.isArray) as unknown[][];
    for (const list of lists) {
      for (const item of list) {
        const slug =
          typeof item === 'string'
            ? item
            : item && typeof item === 'object' && 'slug' in item
              ? String((item as { slug: unknown }).slug)
              : '';
        if (PRO_PLAN_SLUGS.has(slug.replace(/^[uo]:/, '').toLowerCase())) return true;
      }
    }
  }

  // Public metadata fallback (useful in tests / before Billing token refresh).
  const meta = payload.public_metadata ?? payload.publicMetadata;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    const plan = typeof m.plan === 'string' ? m.plan.toLowerCase() : '';
    if (PRO_PLAN_SLUGS.has(plan)) return true;
  }

  return false;
}

export { FREE as FREE_ENTITLEMENTS, PRO as PRO_ENTITLEMENTS };
