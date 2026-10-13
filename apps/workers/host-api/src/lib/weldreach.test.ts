import { describe, expect, it } from 'vitest';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  changesNameservers,
  changesZoneRouting,
  connectedWeldReachDomainIds,
  duplicatesWeldReachRecord,
  isDomainNameUsedByWeldReach,
  isWeldReachManagedRecord,
  markWeldReachRecords,
  toFqdn,
  weldReachDomainNameForZone,
} from './weldreach';

const DOMAIN = 'getacme.com';
const txt = (name: string, value: string) => ({ type: 'TXT', name, value });
const mx = (name: string, value = 'mx.mailpool.io') => ({ type: 'MX', name, value });

describe('toFqdn', () => {
  it.each([
    ['@', 'getacme.com'],
    ['', 'getacme.com'],
    ['getacme.com', 'getacme.com'],
    ['GetAcme.com.', 'getacme.com'],
    ['_dmarc', '_dmarc.getacme.com'],
    ['_dmarc.getacme.com', '_dmarc.getacme.com'],
    ['_dmarc.getacme.com.', '_dmarc.getacme.com'],
    ['mail.getacme.com', 'mail.getacme.com'],
  ])('%j -> %s', (input, expected) => {
    expect(toFqdn(input, DOMAIN)).toBe(expected);
  });
});

describe('isWeldReachManagedRecord', () => {
  it.each([
    ['MX on the apex', mx('getacme.com')],
    ['MX on the apex written as @', mx('@')],
    ['MX with a trailing dot and capitals', mx('GetAcme.com.')],
    ['SPF on the apex', txt('getacme.com', 'v=spf1 include:mailpool.io ~all')],
    ['SPF with Cloudflare quotes', txt('getacme.com', '"v=spf1 include:mailpool.io ~all"')],
    ['SPF with capitals', txt('getacme.com', 'V=SPF1 -all')],
    ['a bare v=spf1', txt('getacme.com', 'v=spf1')],
    ['a DKIM key', txt('mailpool._domainkey.getacme.com', 'v=DKIM1; k=rsa; p=abc')],
    ['a DKIM key of another selector', txt('google._domainkey.getacme.com', 'v=DKIM1; p=xyz')],
    ['a DKIM key with a dotted selector', txt('s1.k._domainkey.getacme.com', 'v=DKIM1; p=xyz')],
    ['DMARC', txt('_dmarc.getacme.com', 'v=DMARC1; p=none')],
    ['DMARC written relative', txt('_dmarc', 'v=DMARC1; p=none')],
    ['a lower-case type', { type: 'txt', name: 'getacme.com', value: 'v=spf1 -all' }],
  ])('is managed: %s', (_label, record) => {
    expect(isWeldReachManagedRecord(DOMAIN, record)).toBe(true);
  });

  it.each([
    ['an MX on a subdomain', mx('mail.getacme.com')],
    ['a TXT verification record on the apex', txt('getacme.com', 'google-site-verification=abc')],
    ['a TXT that only mentions spf', txt('getacme.com', 'note: v=spf1 is set elsewhere')],
    ['an SPF-looking value on a subdomain', txt('mail.getacme.com', 'v=spf1 -all')],
    ['v=spf10', txt('getacme.com', 'v=spf10 -all')],
    ['an A record on the apex', { type: 'A', name: 'getacme.com', value: '1.2.3.4' }],
    ['a CNAME for a DKIM-looking name', { type: 'CNAME', name: 'x._domainkey.getacme.com', value: 'x.example.net' }],
    ['a bare _domainkey TXT', txt('_domainkey.getacme.com', 'o=~')],
    ['the DKIM suffix of another domain', txt('x._domainkey.other.com', 'v=DKIM1')],
    ['DMARC of a subdomain', txt('_dmarc.mail.getacme.com', 'v=DMARC1; p=none')],
  ])('is not managed: %s', (_label, record) => {
    expect(isWeldReachManagedRecord(DOMAIN, record)).toBe(false);
  });
});

describe('duplicatesWeldReachRecord', () => {
  it.each([
    ['an SPF on the apex', txt('getacme.com', 'v=spf1 include:_spf.google.com ~all')],
    ['an SPF written with @', txt('@', '"v=spf1 -all"')],
    ['a DMARC', txt('_dmarc', 'v=DMARC1; p=reject')],
  ])('refuses %s', (_label, record) => {
    expect(duplicatesWeldReachRecord(DOMAIN, record)).toBe(true);
  });

  it.each([
    ['a DKIM key (selectors differ, several can exist)', txt('s2._domainkey.getacme.com', 'v=DKIM1; p=abc')],
    ['an MX', mx('getacme.com')],
    ['a verification TXT on the apex', txt('getacme.com', 'google-site-verification=abc')],
    ['an SPF on a subdomain', txt('mail.getacme.com', 'v=spf1 -all')],
    ['an A record', { type: 'A', name: '@', value: '1.2.3.4' }],
  ])('allows %s', (_label, record) => {
    expect(duplicatesWeldReachRecord(DOMAIN, record)).toBe(false);
  });
});

describe('changesNameservers', () => {
  const existing = { nameservers: ['ns1.weldhost.com', 'ns2.weldhost.com'], customNameservers: false };

  it('is not a change when nothing nameserver-related is sent', () => {
    expect(changesNameservers(existing, {})).toBe(false);
  });

  it('is not a change when the same nameservers come back, in any order or case', () => {
    expect(changesNameservers(existing, { nameservers: ['NS2.weldhost.com.', 'ns1.weldhost.com'] })).toBe(false);
  });

  it('is not a change when customNameservers keeps its value (a missing value counts as false)', () => {
    expect(changesNameservers(existing, { customNameservers: false })).toBe(false);
    expect(changesNameservers({ nameservers: null, customNameservers: null }, { customNameservers: false })).toBe(false);
  });

  it('is a change when the list differs', () => {
    expect(changesNameservers(existing, { nameservers: ['ns1.other.com', 'ns2.other.com'] })).toBe(true);
    expect(changesNameservers(existing, { nameservers: ['ns1.weldhost.com'] })).toBe(true);
    expect(changesNameservers({ nameservers: null }, { nameservers: ['ns1.other.com'] })).toBe(true);
  });

  it('is a change when customNameservers flips', () => {
    expect(changesNameservers(existing, { customNameservers: true })).toBe(true);
  });
});

describe('changesZoneRouting', () => {
  const zone = { provider: 'cloudflare', externalZoneId: 'cfz_1', externalNameservers: ['a.ns.cloudflare.com'] };

  it('ignores unrelated and unchanged fields', () => {
    expect(changesZoneRouting(zone, {})).toBe(false);
    expect(
      changesZoneRouting(zone, {
        provider: 'cloudflare',
        externalZoneId: 'cfz_1',
        externalNameservers: ['A.ns.cloudflare.com'],
      }),
    ).toBe(false);
  });

  it('catches a new provider, zone id or nameserver list', () => {
    expect(changesZoneRouting(zone, { provider: 'route53' })).toBe(true);
    expect(changesZoneRouting(zone, { externalZoneId: 'cfz_2' })).toBe(true);
    expect(changesZoneRouting(zone, { externalZoneId: null })).toBe(true);
    expect(changesZoneRouting(zone, { externalNameservers: ['x.example.net'] })).toBe(true);
  });
});

describe('a tenant database without the reach_domains table', () => {
  const missingTable = () => Promise.reject(Object.assign(new Error('relation "reach_domains" does not exist'), { code: '42P01' }));
  const chain = () => {
    const link: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'leftJoin', 'limit']) link[method] = () => link;
    link.then = (_resolve: unknown, reject: (e: unknown) => unknown) => missingTable().catch(reject);
    return link;
  };
  const dbWithoutTable = { select: chain } as unknown as Database;
  const dbWithDriverError = {
    select: () => {
      const link: Record<string, unknown> = {};
      for (const method of ['from', 'where', 'leftJoin', 'limit']) link[method] = () => link;
      link.then = (_resolve: unknown, reject: (e: unknown) => unknown) => reject(new Error('connection reset'));
      return link;
    },
  } as unknown as Database;

  it('has no connected domains', async () => {
    expect(await connectedWeldReachDomainIds(dbWithoutTable, ['dom_1'])).toEqual(new Set());
    expect(await isDomainNameUsedByWeldReach(dbWithoutTable, 'getacme.com')).toBe(false);
    expect(await weldReachDomainNameForZone(dbWithoutTable, 'zone_1')).toBeNull();
  });

  it('marks no record', async () => {
    const records = [{ zoneId: 'zone_1', type: 'MX', name: DOMAIN, value: 'mx.mailpool.io' }];
    expect(await markWeldReachRecords(dbWithoutTable, records)).toEqual([{ ...records[0], managedBy: null }]);
  });

  it('does not hide any other database error', async () => {
    await expect(connectedWeldReachDomainIds(dbWithDriverError, ['dom_1'])).rejects.toThrow('connection reset');
  });

  it('asks the database nothing for an empty list', async () => {
    const throwing = {
      select: () => {
        throw new Error('should not query');
      },
    } as unknown as Database;
    expect(await connectedWeldReachDomainIds(throwing, [])).toEqual(new Set());
    expect(await markWeldReachRecords(throwing, [])).toEqual([]);
  });
});
