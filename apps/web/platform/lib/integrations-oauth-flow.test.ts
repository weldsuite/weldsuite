import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOAuthFlow, markOAuthFlow, readOAuthFlow } from './integrations-oauth-flow';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('integrations OAuth flow', () => {
  it('remembers a workflow flow with its provider and return page', () => {
    markOAuthFlow({ kind: 'workflow', provider: 'slack', returnTo: '/w/acme/settings/integrations/slack' });
    expect(readOAuthFlow()).toEqual({ kind: 'workflow', provider: 'slack', returnTo: '/w/acme/settings/integrations/slack' });
    // The key the WeldConnect page used, so a flow started before the move still finishes.
    expect(sessionStorage.getItem('wf_oauth_provider')).toBe('slack');
  });

  it('remembers a connector flow and drops a workflow provider left from an earlier one', () => {
    markOAuthFlow({ kind: 'workflow', provider: 'gmail' });
    markOAuthFlow({ kind: 'connector' });
    expect(readOAuthFlow()).toEqual({ kind: 'connector', returnTo: undefined });
    expect(sessionStorage.getItem('wf_oauth_provider')).toBeNull();
  });

  it('finishes a workflow flow started before the move, from the old key alone', () => {
    sessionStorage.setItem('wf_oauth_provider', 'google_sheets');
    expect(readOAuthFlow()).toEqual({ kind: 'workflow', provider: 'google_sheets' });
  });

  it('ignores what it did not write', () => {
    sessionStorage.setItem('integrations_oauth_flow', '{"kind":"workflow"}');
    expect(readOAuthFlow()).toBeNull();
    sessionStorage.setItem('integrations_oauth_flow', 'not json');
    expect(readOAuthFlow()).toBeNull();
  });

  it('forgets the flow once finished', () => {
    markOAuthFlow({ kind: 'workflow', provider: 'slack' });
    clearOAuthFlow();
    expect(readOAuthFlow()).toBeNull();
  });

  it('carries on when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => markOAuthFlow({ kind: 'connector' })).not.toThrow();
    expect(readOAuthFlow()).toBeNull();
  });
});
