/**
 * Mail Domain Provisioning (Cloudflare Email Routing).
 *
 * Auto-provisions a {slug}.weldmail.com mail domain during workspace
 * onboarding. Every workspace mail domain is a SUBDOMAIN of the single
 * shared weldmail.com Cloudflare zone — there is no per-workspace zone.
 *
 *   1. Resolving the weldmail.com apex zone id from Cloudflare.
 *   2. Enabling Email Routing on the zone (locks MX + SPF records).
 *   3. Registering {slug}.weldmail.com as an Email Routing subdomain of the
 *      zone (POST /zones/{id}/email/routing/dns), which adds + locks the
 *      subdomain's MX/SPF records.
 *   4. Setting the zone catch-all routing rule to deliver into the
 *      mail-inbound worker.
 *   5. Authorising {slug}.weldmail.com for outbound Email Sending (DKIM /
 *      return-path records).
 *
 * No DKIM key generation, no per-mailbox principal: Cloudflare manages DKIM
 * automatically and routing is workspace-wide via the catch-all.
 *
 * Pre-requisites:
 *   - The weldmail.com apex zone must exist on the Cloudflare account.
 *   - env.CLOUDFLARE_API_TOKEN must include `Zone.Email Routing` and
 *     `Account.Email Routing Addresses` permissions.
 *
 * ⚠️ Cloudflare limit: a zone supports at most 30 domains across Email
 * Routing + Email Sending COMBINED (apex included), so this shared-zone
 * design caps how many workspace mail domains can be provisioned. Failures
 * past the cap surface as Cloudflare API errors here and are treated as
 * non-fatal by the callers.
 */

import { CloudflareDomainProvider } from '@weldsuite/email/providers/cloudflare';
import type { Env } from '../index';

/** The shared apex zone that hosts every {slug}.weldmail.com mail domain. */
const MAIL_APEX_ZONE = 'weldmail.com';

async function findZoneIdByName(apiToken: string, domain: string): Promise<string | null> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}`,
    { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudflare zones lookup failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { result?: Array<{ id: string }> };
  return json.result?.[0]?.id ?? null;
}

/**
 * Provision a {slug}.weldmail.com email domain for a new workspace.
 *
 * Idempotent: re-enabling routing on an already-routed zone is a no-op
 * server-side, subdomain registration upserts the same locked records, and
 * `PUT catch_all` upserts.
 */
export async function provisionMailDomain(
  env: Env,
  _masterDb: any,
  _workspaceId: string,
  slug: string,
): Promise<void> {
  if (!env.CLOUDFLARE_API_TOKEN) {
    console.log('[MailProvision] No CLOUDFLARE_API_TOKEN, skipping');
    return;
  }
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const domain = `${slug}.${MAIL_APEX_ZONE}`;
  const receiveWorker = env.MAIL_INBOUND_WORKER_NAME ?? 'weldsuite-mail-inbound';
  console.log(`[MailProvision] Provisioning ${domain} via Cloudflare Email Routing → ${receiveWorker}`);

  let cachedZoneId: string | null = null;
  const provider = new CloudflareDomainProvider({
    apiToken,
    // Every {slug}.weldmail.com domain lives inside the shared apex zone —
    // resolve weldmail.com itself, never a per-slug zone.
    resolveZoneId: async () => {
      if (cachedZoneId) return cachedZoneId;
      const zoneId = await findZoneIdByName(apiToken, MAIL_APEX_ZONE);
      if (!zoneId) {
        throw new Error(`No Cloudflare zone for ${MAIL_APEX_ZONE} — the apex mail zone must exist on this Cloudflare account`);
      }
      cachedZoneId = zoneId;
      return zoneId;
    },
    routingSubdomain: (d) => (d === MAIL_APEX_ZONE ? null : d),
    defaultReceiveWorker: receiveWorker,
  });

  const result = await provider.provisionDomain(domain);
  console.log(
    `[MailProvision] Provisioned ${domain}: ruleId=${result.externalRuleId}, ${result.dnsRecords.length} DNS records`,
  );
}
