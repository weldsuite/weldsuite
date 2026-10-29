import { describe, expect, it } from 'vitest';
import { matchesIpFilter } from './ip-filter';

describe('matchesIpFilter', () => {
  it('matches an exact IPv4 address', () => {
    expect(matchesIpFilter('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(matchesIpFilter('203.0.113.8', ['203.0.113.7'])).toBe(false);
  });

  it('matches inside an IPv4 CIDR range and not outside it', () => {
    expect(matchesIpFilter('203.0.113.200', ['203.0.113.0/24'])).toBe(true);
    expect(matchesIpFilter('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
    expect(matchesIpFilter('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(matchesIpFilter('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
  });

  it('handles prefixes that are not on an octet boundary', () => {
    expect(matchesIpFilter('192.168.1.130', ['192.168.1.128/25'])).toBe(true);
    expect(matchesIpFilter('192.168.1.127', ['192.168.1.128/25'])).toBe(false);
  });

  it('handles /32 and /0', () => {
    expect(matchesIpFilter('198.51.100.5', ['198.51.100.5/32'])).toBe(true);
    expect(matchesIpFilter('198.51.100.6', ['198.51.100.5/32'])).toBe(false);
    expect(matchesIpFilter('198.51.100.6', ['0.0.0.0/0'])).toBe(true);
  });

  it('matches IPv6 exactly, whichever way it is written', () => {
    expect(matchesIpFilter('2001:db8::1', ['2001:0db8:0000:0000:0000:0000:0000:0001'])).toBe(true);
    expect(matchesIpFilter('2001:DB8::1', ['2001:db8::1'])).toBe(true);
    expect(matchesIpFilter('2001:db8::2', ['2001:db8::1'])).toBe(false);
    expect(matchesIpFilter('::1', ['::1'])).toBe(true);
  });

  it('matches an IPv6 CIDR range', () => {
    expect(matchesIpFilter('2001:db8:1234::5', ['2001:db8::/32'])).toBe(true);
    expect(matchesIpFilter('2001:db9::5', ['2001:db8::/32'])).toBe(false);
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(matchesIpFilter('::ffff:203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(matchesIpFilter('::ffff:203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(matchesIpFilter('203.0.113.7', ['::ffff:203.0.113.7'])).toBe(true);
  });

  it('never matches across versions', () => {
    expect(matchesIpFilter('203.0.113.7', ['2001:db8::/32'])).toBe(false);
    expect(matchesIpFilter('2001:db8::1', ['203.0.113.0/24'])).toBe(false);
  });

  it('ignores entries and addresses it cannot read', () => {
    expect(matchesIpFilter('203.0.113.7', ['', 'office', '203.0.113.0/33', '203.0.113.0/x', '300.1.1.1', '1.2.3.4/8/9'])).toBe(false);
    expect(matchesIpFilter('not an ip', ['203.0.113.7'])).toBe(false);
    expect(matchesIpFilter('', ['203.0.113.7'])).toBe(false);
    expect(matchesIpFilter(null, ['203.0.113.7'])).toBe(false);
    expect(matchesIpFilter('203.0.113.7', [])).toBe(false);
  });

  it('matches if any entry matches', () => {
    expect(matchesIpFilter('203.0.113.7', ['10.0.0.0/8', 'nonsense', '203.0.113.0/24'])).toBe(true);
  });
});
