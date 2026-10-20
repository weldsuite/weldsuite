import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('@/lib/api/public-env', () => ({
  getApiOrigins: () => ['https://app-api.test', 'https://pass-api.test'],
}));

const originalFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));

function headerOf(call: number): string | null {
  const init = originalFetch.mock.calls[call]?.[1];
  return new Headers(init?.headers).get('X-Weld-App');
}

function goTo(pathname: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname },
  });
}

describe('installAppContextHeader', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', originalFetch);
    const { installAppContextHeader } = await import('./app-context-header');
    installAppContextHeader();
  });

  beforeEach(() => originalFetch.mockClear());

  it.each([
    ['app-api requests', '/weldcrm/companies', 'https://app-api.test/api/companies'],
    ['requests past a /w/{workspace} prefix', '/w/acme/weldcrm/companies', 'https://app-api.test/api/companies'],
    ['module worker requests', '/weldcrm', 'https://pass-api.test/api/weldpass/projects'],
  ])('tags %s with the module in the URL', async (_label, pathname, url) => {
    goTo(pathname);
    await window.fetch(url);
    expect(headerOf(0)).toBe('weldcrm');
  });

  it('keeps existing headers and a caller-set app context', async () => {
    goTo('/welddesk');
    await window.fetch('https://app-api.test/api/x', { headers: { Authorization: 'Bearer t' } });
    await window.fetch('https://app-api.test/api/x', { headers: { 'X-Weld-App': 'workspace' } });
    const first = new Headers(originalFetch.mock.calls[0]?.[1]?.headers);
    expect(first.get('Authorization')).toBe('Bearer t');
    expect(first.get('X-Weld-App')).toBe('welddesk');
    expect(headerOf(1)).toBe('workspace');
  });

  it('does not treat a lookalike host as an API origin', async () => {
    goTo('/weldcrm');
    await window.fetch('https://app-api.test.evil.example/api/companies');
    expect(headerOf(0)).toBeNull();
  });

  it('leaves other origins and app-less screens alone', async () => {
    goTo('/weldcrm');
    await window.fetch('https://elsewhere.test/api/x');
    goTo('/settings/roles');
    await window.fetch('https://app-api.test/api/roles');
    expect(headerOf(0)).toBeNull();
    expect(headerOf(1)).toBeNull();
  });
});
