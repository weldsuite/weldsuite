import { describe, expect, it } from 'vitest';
import { requestAddresses, requestGeo } from './address';

const headers = (entries: Record<string, string>) => new Headers(entries);
const CF = { country: 'NL', region: 'North Holland', city: 'Amsterdam' };

describe('requestAddresses', () => {
  it('takes the first X-Forwarded-For hop as the client, the connecting IP otherwise', () => {
    expect(requestAddresses(headers({ 'X-Forwarded-For': '198.51.100.9, 203.0.113.7', 'CF-Connecting-IP': '203.0.113.7' }))).toEqual({
      client: '198.51.100.9',
      connecting: '203.0.113.7',
    });
    expect(requestAddresses(headers({ 'X-Forwarded-For': ' , 198.51.100.9', 'CF-Connecting-IP': '203.0.113.7' })).client).toBe('198.51.100.9');
    expect(requestAddresses(headers({ 'X-Forwarded-For': ' , ', 'CF-Connecting-IP': '203.0.113.7' })).client).toBe('203.0.113.7');
    expect(requestAddresses(headers({ 'CF-Connecting-IP': '203.0.113.7' }))).toEqual({ client: '203.0.113.7', connecting: '203.0.113.7' });
    expect(requestAddresses(headers({}))).toEqual({ client: '', connecting: '' });
  });
});

describe('requestGeo', () => {
  it("prefers the proxy's own headers, decoded, the country upper-cased", () => {
    expect(
      requestGeo(
        headers({ 'X-WeldPanel-Country': 'de', 'X-WeldPanel-Region': ' Berlin ', 'X-WeldPanel-City': 'Berlin%20Mitte', 'x-vercel-ip-country': 'US' }),
        CF,
      ),
    ).toEqual({ country: 'DE', region: 'Berlin', city: 'Berlin Mitte' });
  });

  it("reads Vercel's headers next, then Cloudflare's", () => {
    expect(requestGeo(headers({ 'x-vercel-ip-country': 'US', 'x-vercel-ip-city': 'S%C3%A3o%20Paulo' }), CF)).toEqual({
      country: 'US',
      region: null,
      city: 'São Paulo',
    });
    expect(requestGeo(headers({ 'X-WeldPanel-Country': '  ' }), CF)).toEqual(CF);
    expect(requestGeo(headers({}), { country: 'XX' })).toEqual({ country: null, region: null, city: null });
  });

  it('refuses a country that is not two letters, keeps a malformed encoding as sent and cuts long values', () => {
    expect(requestGeo(headers({ 'X-WeldPanel-Country': 'Germany', 'X-WeldPanel-City': '100%' }), CF)).toEqual({ country: null, region: null, city: '100%' });
    expect(requestGeo(headers({ 'X-WeldPanel-Country': 'xx' }), CF).country).toBeNull();
    expect(requestGeo(headers({ 'X-WeldPanel-Country': 'DE', 'X-WeldPanel-City': 'a'.repeat(150) }), CF).city).toHaveLength(100);
  });
});
