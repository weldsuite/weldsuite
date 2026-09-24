import { describe, expect, it } from 'vitest';
import { normalizeGatewayPath, pickRequestHeaders, pickResponseHeaders } from './user-app-gateway';

describe('normalizeGatewayPath', () => {
  it('accepts plain external-api paths', () => {
    expect(normalizeGatewayPath('/v1/app-storage/kv/theme')).toBe('/v1/app-storage/kv/theme');
    expect(normalizeGatewayPath('/v1/people/per_123')).toBe('/v1/people/per_123');
    expect(normalizeGatewayPath('/v1/app-storage/kv/a%20b')).toBe('/v1/app-storage/kv/a%20b');
  });

  it('rejects paths outside /v1/', () => {
    expect(normalizeGatewayPath('')).toBeNull();
    expect(normalizeGatewayPath('/v2/people')).toBeNull();
    expect(normalizeGatewayPath('/api/customers')).toBeNull();
    expect(normalizeGatewayPath('v1/people')).toBeNull();
  });

  it('rejects traversal and slash tricks', () => {
    expect(normalizeGatewayPath('/v1/../api/customers')).toBeNull();
    expect(normalizeGatewayPath('/v1/%2e%2e/api')).toBeNull();
    expect(normalizeGatewayPath('/v1/./people')).toBeNull();
    expect(normalizeGatewayPath('/v1//evil.example')).toBeNull();
    expect(normalizeGatewayPath('/v1/people%2f..%2fx')).toBeNull();
    expect(normalizeGatewayPath('/v1/people\\x')).toBeNull();
    expect(normalizeGatewayPath('/v1/%5c%5cx')).toBeNull();
    expect(normalizeGatewayPath('/v1/%E0%A4%A')).toBeNull();
  });
});

describe('header filtering', () => {
  it('drops credentials the app tries to smuggle', () => {
    const picked = pickRequestHeaders(
      new Headers({
        Authorization: 'Bearer wsat_forged',
        Cookie: 'session=1',
        'X-Api-Key': 'wsk_forged',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
    );
    expect(picked.get('authorization')).toBeNull();
    expect(picked.get('cookie')).toBeNull();
    expect(picked.get('x-api-key')).toBeNull();
    expect(picked.get('content-type')).toBe('application/json');
    expect(picked.get('accept')).toBe('application/json');
  });

  it('passes only safe upstream response headers', () => {
    const picked = pickResponseHeaders(
      new Headers({ 'Content-Type': 'application/json', 'Set-Cookie': 'a=b', 'Retry-After': '30' }),
    );
    expect(picked.get('content-type')).toBe('application/json');
    expect(picked.get('retry-after')).toBe('30');
    expect(picked.get('set-cookie')).toBeNull();
  });
});
