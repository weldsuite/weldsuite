/**
 * `accessRequestsUrl` strips trailing slashes with a scan instead of a regex
 * (a `/\/+$/` pattern backtracks quadratically on long runs), so pin the cases.
 */

import { describe, expect, it } from 'vitest';
import { accessRequestsUrl } from './app-access-notify';

describe('accessRequestsUrl: trailing slashes', () => {
  it('drops one or many trailing slashes from ADMIN_CONSOLE_URL', () => {
    expect(accessRequestsUrl({ ADMIN_CONSOLE_URL: 'https://admin-test.example.org/' })).toBe(
      'https://admin-test.example.org/access-requests',
    );
    expect(accessRequestsUrl({ ADMIN_CONSOLE_URL: ' https://admin-test.example.org/// ' })).toBe(
      'https://admin-test.example.org/access-requests',
    );
  });

  it('keeps slashes that are not trailing', () => {
    expect(accessRequestsUrl({ ADMIN_CONSOLE_URL: 'https://example.org/console//' })).toBe(
      'https://example.org/console/access-requests',
    );
  });

  it('falls back to the default for a blank value', () => {
    expect(accessRequestsUrl({ ADMIN_CONSOLE_URL: '   ' })).toBe('https://admin.weldsuite.org/access-requests');
  });

  it('handles a very long run of slashes quickly', () => {
    const start = Date.now();
    const url = accessRequestsUrl({ ADMIN_CONSOLE_URL: `https://example.org${'/'.repeat(200_000)}` });
    expect(url).toBe('https://example.org/access-requests');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
