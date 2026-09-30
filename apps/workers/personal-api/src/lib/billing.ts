/**
 * Clerk Billing entitlements for personal Weld accounts.
 *
 * Plans/features are configured in the Clerk Dashboard (User Plans).
 * Session JWT claims carry plan/feature access after subscribe; we also
 * accept explicit plan/feature lists from verifyToken payload.
 *
 * Expected Clerk setup:
 *   - User Plan slug: `weldmail_pro` (mail send caps)
 *   - User Plan slug: `weldcalendar_pro` (calendar / booking-page caps)
 * Mail Pro does not grant calendar Pro, and vice versa.
 */

export type PersonalPlan = 'free' | 'pro';

export interface PersonalEntitlements {
  plan: PersonalPlan;
  /** Max @weldmail.com addresses (v1: always 1). */
  maxAddresses: number;
  /** Soft daily outbound send cap. */
  dailySendLimit: number;
  calendarPlan: PersonalPlan;
  maxCalendars: number;
  maxBookingPages: number;
}

const MAIL_FREE = { plan: 'free' as const, maxAddresses: 1, dailySendLimit: 50 };
const MAIL_PRO = { plan: 'pro' as const, maxAddresses: 1, dailySendLimit: 500 };
const CAL_FREE = { calendarPlan: 'free' as const, maxCalendars: 1, maxBookingPages: 1 };
const CAL_PRO = { calendarPlan: 'pro' as const, maxCalendars: 10, maxBookingPages: 10 };

const FREE: PersonalEntitlements = { ...MAIL_FREE, ...CAL_FREE };
const PRO: PersonalEntitlements = { ...MAIL_PRO, ...CAL_PRO };

/** Plan / feature slugs to treat as WeldMail Pro. */
const MAIL_PRO_PLAN_SLUGS = new Set(['weldmail_pro', 'pro']);
const MAIL_PRO_FEATURE_SLUGS = new Set(['weldmail_pro', 'pro']);

/** Plan / feature slugs to treat as WeldCalendar Pro. */
const CAL_PRO_PLAN_SLUGS = new Set(['weldcalendar_pro']);
const CAL_PRO_FEATURE_SLUGS = new Set(['weldcalendar_pro']);

/**
 * Resolve entitlements from a verified Clerk JWT payload.
 * Clerk Billing embeds plans/features in session claims (pla / fea).
 */
export function entitlementsFromClerkClaims(payload: Record<string, unknown>): PersonalEntitlements {
  const mail = hasSlugAccess(payload, MAIL_PRO_PLAN_SLUGS, MAIL_PRO_FEATURE_SLUGS) ? MAIL_PRO : MAIL_FREE;
  const calendar = hasSlugAccess(payload, CAL_PRO_PLAN_SLUGS, CAL_PRO_FEATURE_SLUGS) ? CAL_PRO : CAL_FREE;
  return { ...mail, ...calendar };
}

/** Split a comma/space separated claim into normalised slugs (scope prefix stripped). */
function claimSlugs(claim: string): string[] {
  return claim.split(/[,\s]+/).map((p) => p.replace(/^[uo]:/, '').toLowerCase());
}

/** Slug of one entry in a plan list: a bare string or an object with a `slug`. */
function planItemSlug(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && 'slug' in item) {
    return String((item as { slug: unknown }).slug);
  }
  return '';
}

/** `pla` may be a slug string or an object carrying lists of plans. */
function planClaimMatches(pla: unknown, planSlugs: Set<string>): boolean {
  if (typeof pla === 'string') return claimSlugs(pla).some((p) => planSlugs.has(p));
  if (!pla || typeof pla !== 'object') return false;

  const obj = pla as Record<string, unknown>;
  const lists = [obj.u, obj.o, obj.plans, obj.user].filter(Array.isArray) as unknown[][];
  return lists.some((list) =>
    list.some((item) => planSlugs.has(planItemSlug(item).replace(/^[uo]:/, '').toLowerCase())),
  );
}

/** Fallback: plan slugs kept in the user's public metadata. */
function metadataMatches(meta: unknown, planSlugs: Set<string>): boolean {
  if (!meta || typeof meta !== 'object') return false;

  const m = meta as Record<string, unknown>;
  const plan = typeof m.plan === 'string' ? m.plan.toLowerCase() : '';
  if (planSlugs.has(plan)) return true;
  const plans = m.plans;
  return Array.isArray(plans) && plans.some((p) => typeof p === 'string' && planSlugs.has(p.toLowerCase()));
}

function hasSlugAccess(
  payload: Record<string, unknown>,
  planSlugs: Set<string>,
  featureSlugs: Set<string>,
): boolean {
  const fea = payload.fea;
  if (typeof fea === 'string' && claimSlugs(fea).some((p) => featureSlugs.has(p))) return true;

  if (planClaimMatches(payload.pla, planSlugs)) return true;

  return metadataMatches(payload.public_metadata ?? payload.publicMetadata, planSlugs);
}

export { FREE as FREE_ENTITLEMENTS, PRO as PRO_ENTITLEMENTS };
