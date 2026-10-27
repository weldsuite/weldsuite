import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, parseProjectRecord, projectKvKey, seenKvKey, toProjectRecord } from './registry';
import { DEFAULT_PANEL_SETTINGS } from './settings';
import { generateProjectToken, isProjectToken } from './tokens';

describe('project registry record', () => {
  const project = { id: 'pnp_1', status: 'active' as const, allowedDomains: ['example.com'], settings: DEFAULT_PANEL_SETTINGS };

  it('round-trips through KV', () => {
    const record = toProjectRecord(project, 'ws_1');
    expect(parseProjectRecord(JSON.stringify(record))).toEqual(record);
  });

  it('rejects missing, malformed and unknown-version values', () => {
    expect(parseProjectRecord(null)).toBeNull();
    expect(parseProjectRecord('not json')).toBeNull();
    expect(parseProjectRecord(JSON.stringify({ ...toProjectRecord(project, 'ws_1'), v: 2 }))).toBeNull();
  });

  it('namespaces its KV keys under panel:', () => {
    expect(projectKvKey('wpk_x')).toBe('panel:project:wpk_x');
    expect(seenKvKey('pnp_1')).toBe('panel:seen:pnp_1');
  });
});

describe('isAllowedOrigin', () => {
  it('allows any origin when no domains are listed', () => {
    expect(isAllowedOrigin('https://anything.test', [])).toBe(true);
    expect(isAllowedOrigin(null, [])).toBe(true);
  });

  it('allows a listed host and its subdomains, case-insensitively', () => {
    expect(isAllowedOrigin('https://example.com', ['example.com'])).toBe(true);
    expect(isAllowedOrigin('https://Shop.Example.com', ['example.com'])).toBe(true);
    expect(isAllowedOrigin('https://shop.example.com', ['*.example.com'])).toBe(true);
  });

  it('refuses other hosts, look-alikes and a missing origin', () => {
    expect(isAllowedOrigin('https://example.com.evil.test', ['example.com'])).toBe(false);
    expect(isAllowedOrigin('https://notexample.com', ['example.com'])).toBe(false);
    expect(isAllowedOrigin(null, ['example.com'])).toBe(false);
    expect(isAllowedOrigin('garbage', ['example.com'])).toBe(false);
  });
});

describe('project tokens', () => {
  it('look like wpk_ + 32 hex and are unique', () => {
    const a = generateProjectToken();
    const b = generateProjectToken();
    expect(isProjectToken(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isProjectToken('wpk_short')).toBe(false);
  });
});
