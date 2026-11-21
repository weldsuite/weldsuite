import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('@/lib/api/public-env', () => ({
  getApiOrigins: () => ['https://app-api.test', 'https://pass-api.test'],
}));

let activeWorkspaceId: string | null = null;
vi.mock('@/lib/auth', () => ({
  getActiveWorkspaceId: () => activeWorkspaceId,
}));

const originalFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));

function headerOf(call: number): string | null {
  const init = originalFetch.mock.calls[call]?.[1];
  return new Headers(init?.headers).get('X-Weld-Workspace');
}

describe('installWorkspaceHeader', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', originalFetch);
    const { installWorkspaceHeader } = await import('./workspace-header');
    installWorkspaceHeader();
  });

  beforeEach(() => {
    originalFetch.mockClear();
    activeWorkspaceId = null;
  });

  it('tags app-api requests with the active workspace', async () => {
    activeWorkspaceId = 'ws_acme';
    await window.fetch('https://app-api.test/api/companies');
    expect(headerOf(0)).toBe('ws_acme');
  });

  it('tags module worker requests too', async () => {
    activeWorkspaceId = 'ws_acme';
    await window.fetch('https://pass-api.test/api/weldpass/projects');
    expect(headerOf(0)).toBe('ws_acme');
  });

  it('adds nothing before a workspace is active', async () => {
    activeWorkspaceId = null;
    await window.fetch('https://app-api.test/api/companies');
    expect(headerOf(0)).toBeNull();
  });

  it('keeps existing headers and a caller-set workspace', async () => {
    activeWorkspaceId = 'ws_acme';
    await window.fetch('https://app-api.test/api/x', { headers: { Authorization: 'Bearer t' } });
    await window.fetch('https://app-api.test/api/x', { headers: { 'X-Weld-Workspace': 'ws_globex' } });
    const first = new Headers(originalFetch.mock.calls[0]?.[1]?.headers);
    expect(first.get('Authorization')).toBe('Bearer t');
    expect(first.get('X-Weld-Workspace')).toBe('ws_acme');
    expect(headerOf(1)).toBe('ws_globex');
  });

  it('does not tag another origin, even a lookalike host', async () => {
    activeWorkspaceId = 'ws_acme';
    await window.fetch('https://elsewhere.test/api/x');
    await window.fetch('https://app-api.test.evil.example/api/x');
    expect(headerOf(0)).toBeNull();
    expect(headerOf(1)).toBeNull();
  });
});
