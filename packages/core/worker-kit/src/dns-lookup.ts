/**
 * DNS-over-HTTPS lookups via Cloudflare's 1.1.1.1 resolver.
 *
 * Used to verify domain ownership (_weldhost-verify TXT records) and scan
 * existing DNS records on a customer's domain before nameserver cutover.
 */

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'CAA' | 'SRV' | 'NS';

const TYPE_CODES: Record<DnsRecordType, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
};

export interface DnsRecord {
  name: string;
  type: DnsRecordType;
  value: string;
  ttl: number;
  priority?: number;
}

export async function lookupTxt(name: string): Promise<string[]> {
  const records = await lookupRecord(name, 'TXT');
  return records.map((r) => r.value);
}

export async function lookupRecord(name: string, type: DnsRecordType): Promise<DnsRecord[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
  if (!res.ok) throw new Error(`DNS lookup failed with status ${res.status}`);
  const body = (await res.json()) as DohResponse;
  if (!body.Answer) return [];

  const wantCode = TYPE_CODES[type];
  const out: DnsRecord[] = [];
  for (const a of body.Answer) {
    if (a.type !== wantCode) continue;
    const normalisedName = a.name.endsWith('.') ? a.name.slice(0, -1) : a.name;

    switch (type) {
      case 'TXT':
        out.push({ name: normalisedName, type, value: parseTxtData(a.data), ttl: a.TTL });
        break;
      case 'MX': {
        const [prioStr, target] = a.data.split(/\s+/, 2);
        const priority = Number(prioStr);
        const value = (target || '').replace(/\.$/, '');
        out.push({
          name: normalisedName,
          type,
          value,
          ttl: a.TTL,
          priority: Number.isFinite(priority) ? priority : 0,
        });
        break;
      }
      case 'SRV': {
        const parts = a.data.split(/\s+/);
        const priority = Number(parts[0]);
        const rest = parts.slice(1).join(' ').replace(/\.$/, '');
        out.push({
          name: normalisedName,
          type,
          value: rest,
          ttl: a.TTL,
          priority: Number.isFinite(priority) ? priority : 0,
        });
        break;
      }
      case 'CNAME':
      case 'NS':
        out.push({
          name: normalisedName,
          type,
          value: a.data.replace(/\.$/, ''),
          ttl: a.TTL,
        });
        break;
      case 'CAA':
        out.push({ name: normalisedName, type, value: a.data, ttl: a.TTL });
        break;
      default:
        out.push({ name: normalisedName, type, value: a.data, ttl: a.TTL });
    }
  }
  return out;
}

export async function scanDomainRecords(domain: string): Promise<DnsRecord[]> {
  const apexTypes: DnsRecordType[] = ['A', 'AAAA', 'MX', 'TXT', 'CAA', 'NS'];
  const subdomains = [
    'www', 'mail', 'smtp', 'imap', 'pop', 'webmail',
    'autodiscover', 'autoconfig', 'ftp',
    'api', 'app', 'admin', 'blog', 'shop', 'cpanel',
  ];
  const subTypes: DnsRecordType[] = ['A', 'AAAA', 'CNAME'];
  const txtProbes = [
    '_dmarc',
    'default._domainkey',
    'selector1._domainkey',
    'selector2._domainkey',
    'google._domainkey',
  ];

  const jobs: Promise<DnsRecord[]>[] = [];

  for (const t of apexTypes) jobs.push(lookupRecord(domain, t));
  for (const sub of subdomains) {
    for (const t of subTypes) jobs.push(lookupRecord(`${sub}.${domain}`, t));
  }
  for (const probe of txtProbes) jobs.push(lookupRecord(`${probe}.${domain}`, 'TXT'));

  const results = await Promise.allSettled(jobs);
  const found: DnsRecord[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') found.push(...r.value);
  }
  return found;
}

function parseTxtData(raw: string): string {
  const chunks = raw.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!chunks) return raw;
  return chunks.map((c) => c.slice(1, -1)).join('');
}
