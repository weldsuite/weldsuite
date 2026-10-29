/**
 * Project IP filters (`settings.ipFilters`): the team's own office, a staging
 * proxy. Entries are an exact IPv4 or IPv6 address, or a CIDR range
 * (`203.0.113.0/24`, `2001:db8::/32`). The address is compared and dropped,
 * never stored.
 */

interface Address {
  version: 4 | 6;
  value: bigint;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(text: string): bigint | null {
  const m = IPV4.exec(text);
  if (!m) return null;
  let value = 0n;
  for (const part of m.slice(1)) {
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  let rest = text;
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) stands for the last two groups.
  const tail = /(?<=:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(rest);
  if (tail) {
    const v4 = parseIpv4(tail[1]!);
    if (v4 === null) return null;
    rest = rest.slice(0, tail.index) + `${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const end = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - end.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...end];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}

function parseAddress(raw: string): Address | null {
  // `[::1]`, and a zone id (`fe80::1%eth0`) that has no bearing on the address.
  const text = raw.trim().replace(/^\[|\]$/g, '').split('%')[0]!;
  if (!text.includes(':')) {
    const value = parseIpv4(text);
    return value === null ? null : { version: 4, value };
  }
  const value = parseIpv6(text);
  if (value === null) return null;
  // IPv4-mapped (`::ffff:1.2.3.4`) is the same client as 1.2.3.4.
  if (value >> 32n === 0xffffn) return { version: 4, value: value & 0xffffffffn };
  return { version: 6, value };
}

/** Whether `ip` equals or falls inside any entry. Unparseable entries and addresses never match. */
export function matchesIpFilter(ip: string | null | undefined, filters: string[]): boolean {
  if (!ip || filters.length === 0) return false;
  const address = parseAddress(ip);
  if (!address) return false;
  const bits = address.version === 4 ? 32 : 128;

  return filters.some((entry) => {
    const [base, prefix, ...extra] = entry.split('/');
    if (extra.length > 0 || !base) return false;
    const network = parseAddress(base);
    if (!network || network.version !== address.version) return false;

    if (prefix === undefined) return network.value === address.value;
    if (!/^\d{1,3}$/.test(prefix)) return false;
    const length = Number(prefix);
    if (length > bits) return false;
    const shift = BigInt(bits - length);
    return address.value >> shift === network.value >> shift;
  });
}
