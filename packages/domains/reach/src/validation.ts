/**
 * Prospect email validation, run on import and when a prospect is created.
 *
 * Precedence of the verdict, strongest first:
 *   invalid    not a usable address
 *   suppressed on the suppression list (an address or its domain)
 *   consumer   free-mail / consumer provider, unless staff allowed those
 *   role       info@, sales@ ... nobody reads these personally
 *   no_mx      the domain cannot receive mail
 *   valid
 *
 * Suppression and consumer rules are checked again right before every send
 * (`services/scheduler.ts`), so a stale verdict can never cause a bad send.
 */

import { lookupRecord } from '@weldsuite/worker-kit/dns-lookup';
import {
  emailDomain,
  isConsumerEmail,
  isRoleEmail,
  type ReachProspectValidation,
} from '@weldsuite/app-api-client/schemas/reach';
import type { SuppressionIndex } from './suppressions';

/** DNS-over-HTTPS lookups are subrequests; one import never makes more than this many. */
export const MAX_MX_LOOKUPS_PER_RUN = 800;
const MX_CONCURRENCY = 8;

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidEmailSyntax(email: string): boolean {
  if (email.length > 320 || !EMAIL_RE.test(email)) return false;
  const [local = ''] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const domain = emailDomain(email);
  // The last label (the TLD) has to be letters, at least two of them.
  return /\.[A-Za-z]{2,}$/.test(domain);
}

/** `true` the domain has MX records, `false` it has none, `null` the lookup failed (unknown). */
export type MxLookup = (domain: string) => Promise<boolean | null>;

export const dnsMxLookup: MxLookup = async (domain) => {
  try {
    return (await lookupRecord(domain, 'MX')).length > 0;
  } catch {
    return null;
  }
};

export interface EmailValidationContext {
  allowConsumer: boolean;
  suppressed: SuppressionIndex;
  /** Defaults to DNS-over-HTTPS. */
  mxLookup?: MxLookup;
  /** Skip the MX check (cheap local verdicts only). */
  skipMx?: boolean;
}

/** The verdict that needs no network, or null when the address is still a candidate for `valid`/`no_mx`. */
export function classifyLocally(
  email: string,
  ctx: Pick<EmailValidationContext, 'allowConsumer' | 'suppressed'>,
): Exclude<ReachProspectValidation, 'valid' | 'no_mx'> | null {
  if (!isValidEmailSyntax(email)) return 'invalid';
  if (ctx.suppressed.check(email)) return 'suppressed';
  if (!ctx.allowConsumer && isConsumerEmail(email)) return 'consumer';
  if (isRoleEmail(email)) return 'role';
  return null;
}

async function mapLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Verdicts for a batch of lower-cased emails. MX results are cached per domain
 * for the call and looked up with bounded concurrency; a failed lookup, or one
 * beyond MAX_MX_LOOKUPS_PER_RUN, leaves the address `valid` rather than blaming
 * it for our DNS trouble.
 */
export async function validateEmails(
  emails: readonly string[],
  ctx: EmailValidationContext,
): Promise<Map<string, ReachProspectValidation>> {
  const verdicts = new Map<string, ReachProspectValidation>();
  const needMx: string[] = [];

  for (const email of emails) {
    const local = classifyLocally(email, ctx);
    if (local) verdicts.set(email, local);
    else needMx.push(email);
  }

  const mxByDomain = new Map<string, boolean | null>();
  if (!ctx.skipMx) {
    const lookup = ctx.mxLookup ?? dnsMxLookup;
    const domains = [...new Set(needMx.map(emailDomain))].slice(0, MAX_MX_LOOKUPS_PER_RUN);
    await mapLimited(domains, MX_CONCURRENCY, async (domain) => {
      mxByDomain.set(domain, await lookup(domain));
    });
  }

  for (const email of needMx) {
    verdicts.set(email, mxByDomain.get(emailDomain(email)) === false ? 'no_mx' : 'valid');
  }
  return verdicts;
}
