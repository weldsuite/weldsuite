/**
 * WeldMail domain provisioning against a faked Cloudflare: the domain is
 * built on this environment's apex, the catch-all points at this
 * environment's inbound worker, and deprovisioning only removes the deleted
 * workspace's own routing records.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cf = vi.hoisted(() => ({
  providerOptions: [] as Array<Record<string, unknown>>,
  provisioned: [] as string[],
  deprovisioned: [] as string[],
  unlocked: [] as Array<{ zoneId: string; name?: string }>,
  deletedRecords: [] as string[],
  records: [] as Array<{ id: string; name: string; rawType: string; content: string }>,
  sendingNames: [] as string[],
  zones: { 'weldmail.org': 'zone_test', 'weldmail.com': 'zone_prod' } as Record<string, string>,
}));

vi.mock('@weldsuite/cloudflare-zones', () => ({
  findZoneIdByName: vi.fn(async (_token: string, name: string) => cf.zones[name] ?? null),
  listDnsRecordsInZone: vi.fn(async () => cf.records),
  deleteDnsRecordInZone: vi.fn(async (_token: string, _zoneId: string, id: string) => {
    cf.deletedRecords.push(id);
    return { deleted: true, alreadyGone: false };
  }),
}));

vi.mock('@weldsuite/email/providers/cloudflare', () => ({
  CloudflareDomainProvider: class {
    constructor(private readonly opts: Record<string, unknown>) {
      cf.providerOptions.push(opts);
    }
    async provisionDomain(domain: string) {
      await (this.opts.resolveZoneId as (d: string) => Promise<string>)(domain);
      cf.provisioned.push(domain);
      return { ok: true, externalRuleId: 'rule_1', dnsRecords: [] };
    }
    async deprovisionDomain(domain: string) {
      cf.deprovisioned.push(domain);
    }
  },
  CloudflareApiClient: class {
    async unlockRoutingDns(zoneId: string, name?: string) {
      cf.unlocked.push({ zoneId, name });
      return {};
    }
    async listSendingSubdomains() {
      return cf.sendingNames.map((name) => ({ name }));
    }
  },
}));

import type { Env } from '../index';
import {
  deprovisionMailDomain,
  listProvisionedMailDomains,
  provisionMailDomain,
  workspaceMailDomain,
} from './mail-provisioning';

const testEnv = {
  CLOUDFLARE_API_TOKEN: 'token',
  WELDMAIL_DOMAIN: 'weldmail.org',
  MAIL_INBOUND_WORKER_NAME: 'weldsuite-mail-inbound-test',
} as unknown as Env;

beforeEach(() => {
  cf.providerOptions.length = 0;
  cf.provisioned.length = 0;
  cf.deprovisioned.length = 0;
  cf.unlocked.length = 0;
  cf.deletedRecords.length = 0;
  cf.records = [];
  cf.sendingNames = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('workspaceMailDomain', () => {
  it('builds the domain on the environment apex', () => {
    expect(workspaceMailDomain(testEnv, 'acme')).toBe('acme.weldmail.org');
  });

  it('falls back to weldmail.com when WELDMAIL_DOMAIN is unset', () => {
    expect(workspaceMailDomain({} as Env, 'acme')).toBe('acme.weldmail.com');
  });
});

describe('provisionMailDomain', () => {
  it('does nothing without a Cloudflare token', async () => {
    expect(await provisionMailDomain({ ...testEnv, CLOUDFLARE_API_TOKEN: undefined }, null, 'ws_1', 'acme')).toBe(false);
    expect(cf.provisioned).toEqual([]);
  });

  it('provisions {slug}.{apex} in the apex zone with this environment\'s inbound worker', async () => {
    expect(await provisionMailDomain(testEnv, null, 'ws_1', 'acme')).toBe(true);
    expect(cf.provisioned).toEqual(['acme.weldmail.org']);
    const opts = cf.providerOptions[0]!;
    expect(opts.defaultReceiveWorker).toBe('weldsuite-mail-inbound-test');
    const routingSubdomain = opts.routingSubdomain as (d: string) => string | null;
    expect(routingSubdomain('acme.weldmail.org')).toBe('acme.weldmail.org');
    expect(routingSubdomain('weldmail.org')).toBeNull();
  });

  it('throws when the apex zone does not exist', async () => {
    await expect(
      provisionMailDomain({ ...testEnv, WELDMAIL_DOMAIN: 'missing.example' }, null, 'ws_1', 'acme'),
    ).rejects.toThrow(/No Cloudflare zone for missing\.example/);
  });
});

describe('deprovisionMailDomain', () => {
  it('removes the sending subdomain and only that name\'s routing records', async () => {
    cf.records = [
      { id: 'mx1', name: 'acme.weldmail.org', rawType: 'MX', content: 'route1.mx.cloudflare.net' },
      { id: 'spf', name: 'acme.weldmail.org', rawType: 'TXT', content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
      { id: 'dkim', name: 'cf-bounce._domainkey.acme.weldmail.org', rawType: 'TXT', content: 'v=DKIM1; p=abc' },
      { id: 'other-mx', name: 'beta.weldmail.org', rawType: 'MX', content: 'route1.mx.cloudflare.net' },
      { id: 'apex-mx', name: 'weldmail.org', rawType: 'MX', content: 'route2.mx.cloudflare.net' },
      { id: 'own-txt', name: 'acme.weldmail.org', rawType: 'TXT', content: 'google-site-verification=x' },
    ];

    expect(await deprovisionMailDomain(testEnv, 'acme')).toBe(true);

    expect(cf.deprovisioned).toEqual(['acme.weldmail.org']);
    expect(cf.unlocked).toEqual([{ zoneId: 'zone_test', name: 'acme.weldmail.org' }]);
    expect(cf.deletedRecords).toEqual(['mx1', 'spf']);
  });

  it('does nothing without a Cloudflare token', async () => {
    expect(await deprovisionMailDomain({ ...testEnv, CLOUDFLARE_API_TOKEN: undefined }, 'acme')).toBe(false);
    expect(cf.deprovisioned).toEqual([]);
  });
});

describe('listProvisionedMailDomains', () => {
  it('lists the apex zone\'s sending subdomains, lower-cased', async () => {
    cf.sendingNames = ['Acme.weldmail.org', 'weldmail.org'];
    expect(await listProvisionedMailDomains(testEnv)).toEqual(new Set(['acme.weldmail.org', 'weldmail.org']));
  });

  it('is null while the apex zone does not exist', async () => {
    expect(await listProvisionedMailDomains({ ...testEnv, WELDMAIL_DOMAIN: 'missing.example' })).toBeNull();
  });
});
