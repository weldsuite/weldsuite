/**
 * DNS checks for WeldReach domains, over DNS-over-HTTPS (worker-kit's
 * `dns-lookup`).
 *
 * 1. The connect guard: Mailpool writes its own MX, SPF, DKIM and DMARC records
 *    when a domain is connected, which would break a domain that already carries
 *    the customer's email or website. `checkDomainFootprint` finds out whether it
 *    does (MX records, or A/AAAA on the apex or `www`).
 * 2. DNS health after connecting: `evaluateMailDns` compares what Mailpool says
 *    it wrote with what a resolver actually returns.
 *
 * Every lookup failure throws `DnsLookupError`. Callers fail closed (the
 * connect guard) or keep the previous status (the health check); a failed
 * lookup is never read as "no records".
 */

import { lookupRecord, type DnsRecord, type DnsRecordType } from '@weldsuite/worker-kit/dns-lookup';
import type { ReachDnsStatus } from '@weldsuite/app-api-client/schemas/reach';
import type { MailpoolDnsRecord } from './mailpool/types';

export type DnsLookup = (name: string, type: DnsRecordType) => Promise<DnsRecord[]>;

export class DnsLookupError extends Error {
  constructor(name: string, type: string, cause: unknown) {
    super(`DNS lookup of ${type} ${name} failed`);
    this.name = 'DnsLookupError';
    this.cause = cause;
  }
}

async function safeLookup(lookup: DnsLookup, name: string, type: DnsRecordType): Promise<DnsRecord[]> {
  try {
    return await lookup(name, type);
  } catch (err) {
    throw new DnsLookupError(name, type, err);
  }
}

// ---------------------------------------------------------------------------
// Connect guard
// ---------------------------------------------------------------------------

export interface DomainFootprint {
  hasMx: boolean;
  mxHosts: string[];
  /** A/AAAA answers on the apex or on `www`. */
  hasWebsite: boolean;
  websiteHosts: string[];
}

export async function checkDomainFootprint(domain: string, lookup: DnsLookup = lookupRecord): Promise<DomainFootprint> {
  const name = domain.trim().toLowerCase().replace(/\.$/, '');
  const [mx, apexA, apexAaaa, wwwA, wwwAaaa] = await Promise.all([
    safeLookup(lookup, name, 'MX'),
    safeLookup(lookup, name, 'A'),
    safeLookup(lookup, name, 'AAAA'),
    safeLookup(lookup, `www.${name}`, 'A'),
    safeLookup(lookup, `www.${name}`, 'AAAA'),
  ]);

  const websiteHosts = [
    ...(apexA.length || apexAaaa.length ? [name] : []),
    ...(wwwA.length || wwwAaaa.length ? [`www.${name}`] : []),
  ];
  return {
    hasMx: mx.length > 0,
    // A null MX ("0 .") is the explicit "no mail here" marker and leaves the value empty.
    mxHosts: mx.map((r) => r.value).filter(Boolean),
    hasWebsite: websiteHosts.length > 0,
    websiteHosts,
  };
}

// ---------------------------------------------------------------------------
// DNS health
// ---------------------------------------------------------------------------

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** TXT values compare without quotes, spaces and case (long DKIM keys are split into chunks). */
function normaliseTxt(value: string): string {
  return value.replaceAll('"', '').replaceAll(/\s+/g, '').toLowerCase();
}

/** `@`, a relative label or an FQDN, as the fully qualified name inside `domain`. */
export function recordName(key: string | undefined, domain: string): string {
  const k = normalise(key ?? '');
  const d = normalise(domain);
  if (k === '' || k === '@') return d;
  if (k === d || k.endsWith(`.${d}`)) return k;
  return `${k}.${d}`;
}

function spfMechanisms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => /^(include:|ip4:|ip6:|redirect=)/.test(token));
}

export interface EvaluateMailDnsInput {
  domain: string;
  /** The records Mailpool wrote (GET /domains/{id}/dns). */
  expected: MailpoolDnsRecord[];
  lookup?: DnsLookup;
  now?: Date;
}

export async function evaluateMailDns(input: EvaluateMailDnsInput): Promise<ReachDnsStatus> {
  const lookup = input.lookup ?? lookupRecord;
  const domain = normalise(input.domain);
  const expected = input.expected;
  const at = (record: MailpoolDnsRecord) => recordName(record.key, domain);

  const expectedMx = expected.filter((r) => r.type === 'MX' && at(r) === domain);
  const expectedSpf = expected.find((r) => r.type === 'TXT' && at(r) === domain && /^"?v=spf1/i.test(r.value.trim()));
  const expectedDkim = expected.filter((r) => (r.type === 'TXT' || r.type === 'CNAME') && at(r).includes('._domainkey.'));

  const [liveMx, liveApexTxt, liveDmarcTxt, dkimLive] = await Promise.all([
    safeLookup(lookup, domain, 'MX'),
    safeLookup(lookup, domain, 'TXT'),
    safeLookup(lookup, `_dmarc.${domain}`, 'TXT'),
    Promise.all(expectedDkim.map((r) => safeLookup(lookup, at(r), r.type as DnsRecordType))),
  ]);

  const liveMxHosts = new Set(liveMx.map((r) => normalise(r.value)));
  const mx =
    expectedMx.length > 0
      ? expectedMx.every((r) => liveMxHosts.has(normalise(r.value)))
      : [...liveMxHosts].some((host) => host !== '');

  const liveSpf = liveApexTxt.map((r) => r.value).filter((v) => /^v=spf1/i.test(v.trim()));
  const spf =
    liveSpf.length > 0 &&
    (!expectedSpf ||
      liveSpf.some((v) => {
        const have = new Set(spfMechanisms(v));
        return spfMechanisms(expectedSpf.value).every((m) => have.has(m));
      }));

  const dkim =
    expectedDkim.length > 0 &&
    expectedDkim.every((record, i) => {
      const answers = dkimLive[i] ?? [];
      const want = record.type === 'TXT' ? normaliseTxt(record.value) : normalise(record.value);
      return answers.some((a) => (record.type === 'TXT' ? normaliseTxt(a.value) : normalise(a.value)) === want);
    });

  const dmarc = liveDmarcTxt.some((r) => /v=dmarc1/i.test(r.value));

  return { spf, dkim, dmarc, mx, checkedAt: (input.now ?? new Date()).toISOString() };
}

/** All four mail records resolve as Mailpool wrote them. */
export function isDnsHealthy(status: ReachDnsStatus | null | undefined): boolean {
  return !!status && status.spf && status.dkim && status.dmarc && status.mx;
}
