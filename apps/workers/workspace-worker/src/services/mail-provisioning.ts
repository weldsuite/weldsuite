/**
 * Mail Domain Provisioning (Cloudflare Email Routing).
 *
 * Auto-provisions a {slug}.{WELDMAIL_DOMAIN} mail domain during workspace
 * onboarding. Every workspace mail domain is a SUBDOMAIN of one shared apex
 * Cloudflare zone — there is no per-workspace zone. Each environment has its
 * own apex (weldmail.com in production, weldmail.org on test), because a zone
 * has exactly one Email Routing catch-all and it must point at that
 * environment's inbound worker (docs/plans/weldmail-test-mail-zone.md).
 *
 *   1. Resolving the apex zone id from Cloudflare.
 *   2. Enabling Email Routing on the zone (locks MX + SPF records).
 *   3. Registering {slug}.{apex} as an Email Routing subdomain of the
 *      zone (POST /zones/{id}/email/routing/dns), which adds + locks the
 *      subdomain's MX/SPF records.
 *   4. Setting the zone catch-all routing rule to deliver into the
 *      mail-inbound worker named by MAIL_INBOUND_WORKER_NAME.
 *   5. Authorising {slug}.{apex} for outbound Email Sending (DKIM /
 *      return-path records).
 *
 * No DKIM key generation, no per-mailbox principal: Cloudflare manages DKIM
 * automatically and routing is workspace-wide via the catch-all.
 *
 * Pre-requisites:
 *   - The apex zone must exist on the Cloudflare account.
 *   - env.CLOUDFLARE_API_TOKEN must include `Zone.Email Routing` and
 *     `Account.Email Routing Addresses` permissions.
 *
 * ⚠️ Cloudflare limit: a zone supports at most 30 domains across Email
 * Routing + Email Sending COMBINED (apex included), so this shared-zone
 * design caps how many workspace mail domains can be provisioned. A deleted
 * workspace gives its slot back (`deprovisionMailDomain`).
 */

import { CloudflareApiClient, CloudflareDomainProvider } from '@weldsuite/email/providers/cloudflare';
import {
  deleteDnsRecordInZone,
  findZoneIdByName,
  listDnsRecordsInZone,
  type CloudflareDnsRecord,
} from '@weldsuite/cloudflare-zones';
import {
  DEFAULT_WELDMAIL_APEX,
  weldMailDomainFor,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { Env } from '../index';

/** The shared apex zone that hosts every {slug}.{apex} mail domain in this environment. */
export function mailApexZone(env: Pick<Env, 'WELDMAIL_DOMAIN'>): string {
  return env.WELDMAIL_DOMAIN || DEFAULT_WELDMAIL_APEX;
}

/** A workspace's shared mail domain in this environment. */
export function workspaceMailDomain(env: Pick<Env, 'WELDMAIL_DOMAIN'>, slug: string): string {
  return weldMailDomainFor(slug, env.WELDMAIL_DOMAIN);
}

function makeProvider(env: Env, apiToken: string): CloudflareDomainProvider {
  const apex = mailApexZone(env);
  let cachedZoneId: string | null = null;
  return new CloudflareDomainProvider({
    apiToken,
    // Every workspace domain lives inside the shared apex zone — resolve the
    // apex itself, never a per-slug zone.
    resolveZoneId: async () => {
      if (cachedZoneId) return cachedZoneId;
      const zoneId = await findZoneIdByName(apiToken, apex);
      if (!zoneId) {
        throw new Error(`No Cloudflare zone for ${apex} — the apex mail zone must exist on this Cloudflare account`);
      }
      cachedZoneId = zoneId;
      return zoneId;
    },
    routingSubdomain: (d) => (d === apex ? null : d),
    defaultReceiveWorker: env.MAIL_INBOUND_WORKER_NAME ?? 'weldsuite-mail-inbound',
  });
}

/**
 * Provision a {slug}.{apex} email domain for a workspace. Returns false when
 * Cloudflare isn't configured (local dev); throws when Cloudflare refuses, so
 * callers can leave the tenant `mail_domains` row pending for a retry.
 *
 * Idempotent: re-enabling routing on an already-routed zone is a no-op
 * server-side, subdomain registration upserts the same locked records, and
 * `PUT catch_all` upserts.
 */
export async function provisionMailDomain(
  env: Env,
  _masterDb: unknown,
  _workspaceId: string,
  slug: string,
): Promise<boolean> {
  if (!env.CLOUDFLARE_API_TOKEN) {
    console.log('[MailProvision] No CLOUDFLARE_API_TOKEN, skipping');
    return false;
  }
  const domain = workspaceMailDomain(env, slug);
  const receiveWorker = env.MAIL_INBOUND_WORKER_NAME ?? 'weldsuite-mail-inbound';
  console.log(`[MailProvision] Provisioning ${domain} via Cloudflare Email Routing → ${receiveWorker}`);

  const result = await makeProvider(env, env.CLOUDFLARE_API_TOKEN).provisionDomain(domain);
  console.log(
    `[MailProvision] Provisioned ${domain}: ruleId=${result.externalRuleId}, ${result.dnsRecords.length} DNS records`,
  );
  return true;
}

/** The MX/SPF records Email Routing publishes for a routed name. */
function isRoutingRecord(record: CloudflareDnsRecord): boolean {
  if (record.rawType === 'MX') return record.content.toLowerCase().endsWith('.mx.cloudflare.net');
  if (record.rawType === 'TXT') return record.content.includes('include:_spf.mx.cloudflare.net');
  return false;
}

/**
 * Give a deleted workspace's slot on the shared zone back: removes its Email
 * Sending authorisation, then unlocks and deletes its Email Routing MX/SPF
 * records (Cloudflare has no "remove routing subdomain" call; the zone-wide
 * disable is never used here). Only records named exactly {slug}.{apex} are
 * touched — never the apex or the zone-wide catch-all. Throws on Cloudflare
 * errors.
 */
export async function deprovisionMailDomain(env: Env, slug: string): Promise<boolean> {
  if (!env.CLOUDFLARE_API_TOKEN) return false;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const apex = mailApexZone(env);
  const domain = workspaceMailDomain(env, slug).toLowerCase();
  if (domain === apex) throw new Error(`Refusing to deprovision the mail apex ${apex}`);

  // Sending subdomain (the provider never disables routing for a subdomain).
  await makeProvider(env, apiToken).deprovisionDomain(domain);

  const zoneId = await findZoneIdByName(apiToken, apex);
  if (!zoneId) return true;
  await new CloudflareApiClient(apiToken).unlockRoutingDns(zoneId, domain);
  const records = (await listDnsRecordsInZone(apiToken, zoneId)).filter(
    (r) => r.name.toLowerCase() === domain && isRoutingRecord(r),
  );
  for (const record of records) {
    await deleteDnsRecordInZone(apiToken, zoneId, record.id);
  }
  console.log(`[MailProvision] Deprovisioned ${domain} (${records.length} routing records removed)`);
  return true;
}

/**
 * Workspace mail domains that are fully provisioned on this environment's
 * apex zone: the Email Sending subdomains (sending is the last provisioning
 * step, so a listed domain also has routing). Lower-cased. Null when
 * Cloudflare isn't configured or the apex zone doesn't exist yet.
 */
export async function listProvisionedMailDomains(env: Env): Promise<Set<string> | null> {
  if (!env.CLOUDFLARE_API_TOKEN) return null;
  const apex = mailApexZone(env);
  const zoneId = await findZoneIdByName(env.CLOUDFLARE_API_TOKEN, apex);
  if (!zoneId) {
    console.warn(`[MailProvision] No Cloudflare zone for ${apex}; nothing to compare against`);
    return null;
  }
  const subdomains = await new CloudflareApiClient(env.CLOUDFLARE_API_TOKEN).listSendingSubdomains(zoneId);
  return new Set(subdomains.map((s) => s.name.toLowerCase()));
}
