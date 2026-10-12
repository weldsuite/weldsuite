import { describe, expect, it } from 'vitest';
import type { DnsRecord, DnsRecordType } from '@weldsuite/worker-kit/dns-lookup';
import { checkDomainFootprint, DnsLookupError, evaluateMailDns, isDnsHealthy, recordName, type DnsLookup } from './dns';
import type { MailpoolDnsRecord } from './mailpool/types';

/** A resolver over a static zone: `"<name>|<TYPE>"` -> records. */
function resolver(zone: Record<string, Array<Partial<DnsRecord> & { value: string }>>): DnsLookup {
  return async (name: string, type: DnsRecordType) =>
    (zone[`${name}|${type}`] ?? []).map((r) => ({ name, type, ttl: 300, ...r }));
}

describe('checkDomainFootprint', () => {
  it('finds nothing on an empty domain', async () => {
    const footprint = await checkDomainFootprint('getacme.com', resolver({}));
    expect(footprint).toEqual({ hasMx: false, mxHosts: [], hasWebsite: false, websiteHosts: [] });
  });

  it('reports MX records', async () => {
    const lookup = resolver({ 'getacme.com|MX': [{ value: 'aspmx.l.google.com', priority: 1 }] });
    const footprint = await checkDomainFootprint('getacme.com', lookup);
    expect(footprint.hasMx).toBe(true);
    expect(footprint.mxHosts).toEqual(['aspmx.l.google.com']);
    expect(footprint.hasWebsite).toBe(false);
  });

  it('reports a website from A on the apex, AAAA on the apex, or either on www', async () => {
    for (const key of ['getacme.com|A', 'getacme.com|AAAA', 'www.getacme.com|A', 'www.getacme.com|AAAA']) {
      const footprint = await checkDomainFootprint('getacme.com', resolver({ [key]: [{ value: '203.0.113.7' }] }));
      expect(footprint.hasWebsite, key).toBe(true);
    }
  });

  it('normalises the name', async () => {
    const lookup = resolver({ 'getacme.com|MX': [{ value: 'mx.x.com' }] });
    expect((await checkDomainFootprint('GetAcme.com.', lookup)).hasMx).toBe(true);
  });

  it('fails closed: a lookup error is thrown, never read as "no records"', async () => {
    const broken: DnsLookup = async () => {
      throw new Error('resolver down');
    };
    await expect(checkDomainFootprint('getacme.com', broken)).rejects.toBeInstanceOf(DnsLookupError);
  });
});

describe('recordName', () => {
  it('resolves @, relative labels and FQDNs inside the domain', () => {
    expect(recordName('@', 'getacme.com')).toBe('getacme.com');
    expect(recordName(undefined, 'getacme.com')).toBe('getacme.com');
    expect(recordName('_dmarc', 'getacme.com')).toBe('_dmarc.getacme.com');
    expect(recordName('_dmarc.getacme.com', 'getacme.com')).toBe('_dmarc.getacme.com');
    expect(recordName('google._domainkey', 'getacme.com')).toBe('google._domainkey.getacme.com');
    expect(recordName('GETACME.com.', 'getacme.com')).toBe('getacme.com');
  });
});

describe('evaluateMailDns', () => {
  const domain = 'getacme.com';
  const now = new Date('2026-10-12T10:00:00Z');
  const expected: MailpoolDnsRecord[] = [
    { type: 'MX', key: '@', priority: 1, value: 'smtp.google.com' },
    { type: 'TXT', key: '@', value: 'v=spf1 include:_spf.google.com ~all' },
    { type: 'TXT', key: 'google._domainkey', value: 'v=DKIM1; k=rsa; p=ABCDEF' },
    { type: 'TXT', key: '_dmarc', value: 'v=DMARC1; p=none' },
  ];
  const healthyZone = {
    'getacme.com|MX': [{ value: 'smtp.google.com', priority: 1 }],
    'getacme.com|TXT': [{ value: 'v=spf1 include:_spf.google.com ~all' }],
    'google._domainkey.getacme.com|TXT': [{ value: 'v=DKIM1; k=rsa; p=ABCDEF' }],
    '_dmarc.getacme.com|TXT': [{ value: 'v=DMARC1; p=none' }],
  };

  it('is healthy when every record resolves as Mailpool wrote it', async () => {
    const status = await evaluateMailDns({ domain, expected, lookup: resolver(healthyZone), now });
    expect(status).toEqual({ spf: true, dkim: true, dmarc: true, mx: true, checkedAt: now.toISOString() });
    expect(isDnsHealthy(status)).toBe(true);
  });

  it('flags each record that has not propagated', async () => {
    const status = await evaluateMailDns({ domain, expected, lookup: resolver({}), now });
    expect(status).toMatchObject({ spf: false, dkim: false, dmarc: false, mx: false });
    expect(isDnsHealthy(status)).toBe(false);
  });

  it('wants the MX hosts Mailpool wrote, not just any MX', async () => {
    const status = await evaluateMailDns({
      domain,
      expected,
      lookup: resolver({ ...healthyZone, 'getacme.com|MX': [{ value: 'mail.someone-else.com', priority: 5 }] }),
      now,
    });
    expect(status.mx).toBe(false);
  });

  it('wants the SPF mechanisms Mailpool wrote', async () => {
    const status = await evaluateMailDns({
      domain,
      expected,
      lookup: resolver({ ...healthyZone, 'getacme.com|TXT': [{ value: 'v=spf1 include:other.example ~all' }] }),
      now,
    });
    expect(status.spf).toBe(false);
  });

  it('compares a long DKIM key without quotes, spaces or case', async () => {
    const status = await evaluateMailDns({
      domain,
      expected,
      lookup: resolver({ ...healthyZone, 'google._domainkey.getacme.com|TXT': [{ value: '"v=DKIM1; k=rsa; " "p=abcdef"' }] }),
      now,
    });
    expect(status.dkim).toBe(true);
  });

  it('without expected records falls back to what exists (MX, SPF) and treats DKIM as missing', async () => {
    const status = await evaluateMailDns({
      domain,
      expected: [],
      lookup: resolver({
        'getacme.com|MX': [{ value: 'mx.any.com' }],
        'getacme.com|TXT': [{ value: 'v=spf1 -all' }],
        '_dmarc.getacme.com|TXT': [{ value: 'v=DMARC1; p=reject' }],
      }),
      now,
    });
    expect(status).toMatchObject({ mx: true, spf: true, dmarc: true, dkim: false });
  });

  it('throws on a lookup failure so a stored status is never overwritten with false negatives', async () => {
    const broken: DnsLookup = async () => {
      throw new Error('resolver down');
    };
    await expect(evaluateMailDns({ domain, expected, lookup: broken })).rejects.toBeInstanceOf(DnsLookupError);
  });
});
