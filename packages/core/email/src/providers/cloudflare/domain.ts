/**
 * Cloudflare Email Routing → IMailDomainProvider.
 *
 * `provisionDomain` is the workspace-onboarding entry point:
 *   1. Enable Email Routing on the zone (auto-locks MX + SPF records).
 *   2. PUT the catch-all rule pointing at the receive worker.
 *
 * Cloudflare also auto-manages DKIM (ARC-DKIM) for routed zones, so DKIM is
 * not in the returned record set unless the caller asks for it explicitly.
 */

import { ProviderConfigError } from '../../core/errors';
import type {
  IMailDomainProvider,
  MailDnsRecord,
  ProvisionDomainOptions,
  ProvisionDomainResult,
} from '../../core/types';
import { CloudflareApiClient } from './api-client';
import type { CfDnsRecord, CfSendingSubdomain } from './types';

const PROVIDER = 'cloudflare';

export interface CloudflareDomainProviderOptions {
  apiToken: string;
  /** Resolves a domain name to its Cloudflare zone id. The api-worker already
   *  has a helper for this in `lib/cloudflare-zones.ts`. */
  resolveZoneId: (domain: string) => Promise<string>;
  defaultReceiveWorker?: string;
  /**
   * Also register the domain with Cloudflare Email Sending so outbound
   * delivery via the `[[send_email]]` binding is authorised and DKIM /
   * return-path records are published. Defaults to true.
   */
  provisionSending?: boolean;
  /**
   * The name to pass to POST /zones/{id}/email/sending/subdomains. Given the
   * zone's domain, returns the fully-qualified name to authorise. Defaults
   * to the zone apex itself.
   */
  sendingSubdomainName?: (domain: string) => string;
  /**
   * When the provisioned domain is a SUBDOMAIN of the zone `resolveZoneId`
   * returns (e.g. `{slug}.weldmail.com` inside the shared `weldmail.com`
   * zone), return the subdomain FQDN so it gets registered for Email Routing
   * via POST /zones/{id}/email/routing/dns. Return null when `domain` is the
   * zone apex. Defaults to null (apex-only, the original behaviour).
   */
  routingSubdomain?: (domain: string) => string | null;
}

export class CloudflareDomainProvider implements IMailDomainProvider {
  readonly name = PROVIDER;
  private readonly client: CloudflareApiClient;

  constructor(private readonly opts: CloudflareDomainProviderOptions) {
    if (!opts.apiToken) throw new ProviderConfigError(PROVIDER, 'apiToken');
    if (!opts.resolveZoneId) throw new ProviderConfigError(PROVIDER, 'resolveZoneId');
    this.client = new CloudflareApiClient(opts.apiToken);
  }

  async provisionDomain(
    domain: string,
    options: ProvisionDomainOptions = {},
  ): Promise<ProvisionDomainResult> {
    const zoneId = await this.opts.resolveZoneId(domain);

    // 1. Enable routing — this writes + locks the MX/SPF records.
    const settings = await this.client.enableRouting(zoneId);

    // 1b. When `domain` is a subdomain of the zone, register it for Email
    // Routing (adds + locks the subdomain's MX/SPF records). Idempotent.
    const routingSubdomain = this.opts.routingSubdomain?.(domain) ?? null;
    if (routingSubdomain) {
      await this.client.configureRoutingDns(zoneId, routingSubdomain);
    }

    // 2. Catch-all → worker (or forward, if a forward address was specified).
    const receiveWorker = options.receiveWorkerName ?? this.opts.defaultReceiveWorker;
    if (!receiveWorker && !options.catchAllForward) {
      throw new ProviderConfigError(PROVIDER, 'receiveWorkerName or catchAllForward');
    }

    const rule = await this.client.putCatchAll(zoneId, {
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: receiveWorker
        ? [{ type: 'worker', value: [receiveWorker] }]
        : [{ type: 'forward', value: [options.catchAllForward!] }],
    });

    // 3. Email Sending — authorise the zone for outbound delivery and
    // publish DKIM / return-path records. Idempotent: if the subdomain is
    // already registered we re-use the existing row instead of erroring.
    let sending: CfSendingSubdomain | undefined;
    if (this.opts.provisionSending ?? true) {
      const sendingName = this.opts.sendingSubdomainName?.(domain) ?? domain;
      sending = await this.ensureSendingSubdomain(zoneId, sendingName);
    }

    const dnsRecords = await this.getDnsRecords(domain);

    return {
      ok: true,
      externalRuleId: rule.id,
      dnsRecords,
      metadata: { zoneId, settings, sending },
    };
  }

  private async ensureSendingSubdomain(
    zoneId: string,
    name: string,
  ): Promise<CfSendingSubdomain> {
    const existing = await this.client.listSendingSubdomains(zoneId).catch(() => []);
    const match = existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (match) return match;
    return this.client.createSendingSubdomain(zoneId, name);
  }

  async deprovisionDomain(domain: string): Promise<void> {
    const zoneId = await this.opts.resolveZoneId(domain);

    if (this.opts.provisionSending ?? true) {
      const sendingName = this.opts.sendingSubdomainName?.(domain) ?? domain;
      const existing = await this.client.listSendingSubdomains(zoneId).catch(() => []);
      const match = existing.find((s) => s.name.toLowerCase() === sendingName.toLowerCase());
      if (match) {
        await this.client.deleteSendingSubdomain(zoneId, match.tag).catch(() => undefined);
      }
    }

    // Disabling routing is ZONE-wide. When `domain` is a subdomain of a
    // shared zone, other domains on that zone must keep routing, so only
    // the apex case may disable it (the subdomain's sending authorisation
    // was already removed above).
    if (!this.opts.routingSubdomain?.(domain)) {
      await this.client.disableRouting(zoneId);
    }
  }

  async getDnsRecords(domain: string): Promise<MailDnsRecord[]> {
    const zoneId = await this.opts.resolveZoneId(domain);
    const records = await this.client.getRoutingDns(zoneId, this.opts.routingSubdomain?.(domain) ?? undefined);
    return records.map(cfDnsToMailDns);
  }

  async verifyDomain(
    domain: string,
  ): Promise<{ verified: boolean; records: MailDnsRecord[] }> {
    const zoneId = await this.opts.resolveZoneId(domain);
    const settings = await this.client.getRoutingSettings(zoneId);
    const records = await this.getDnsRecords(domain);
    return { verified: settings.status === 'ready', records };
  }
}

function cfDnsToMailDns(rec: CfDnsRecord): MailDnsRecord {
  const type = rec.type.toUpperCase();
  return {
    type: (['MX', 'TXT', 'CNAME', 'A', 'AAAA'].includes(type) ? type : 'TXT') as MailDnsRecord['type'],
    name: rec.name,
    value: rec.content,
    priority: rec.priority,
    ttl: rec.ttl,
    purpose: type === 'MX' ? 'mx' : rec.content.startsWith('v=spf1') ? 'spf' : 'other',
    status: 'verified',
  };
}
