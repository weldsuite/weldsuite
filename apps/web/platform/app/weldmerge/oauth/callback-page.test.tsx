import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import WeldMergeOauthCallbackPage, { resolveReturnTo } from './callback-page';

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@/lib/router', () => ({ useRouter: () => ({ replace: state.replace, push: vi.fn() }) }));
vi.mock('@/hooks/queries/use-weldmerge-sync-queries', () => ({
  useMergeOauthCallback: () => ({ mutate: state.mutate, isPending: false }),
  useSetMergeAzureOrganization: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const connected = {
  purpose: 'connection' as const,
  provider: 'gitlab' as const,
  returnTo: '/weldmerge/settings?tab=providers',
  connectionId: 'mcn_1',
  accountId: null,
};

describe('resolveReturnTo', () => {
  it('keeps a same-app path and falls back to the tab for what was linked', () => {
    expect(resolveReturnTo({ purpose: 'connection', returnTo: '/weldmerge/issues' })).toBe('/weldmerge/issues');
    expect(resolveReturnTo({ purpose: 'connection', returnTo: null })).toBe('/weldmerge/settings?tab=providers');
    expect(resolveReturnTo({ purpose: 'account', returnTo: null })).toBe('/weldmerge/settings?tab=accounts');
  });

  it('ignores an address that leaves the app', () => {
    expect(resolveReturnTo({ purpose: 'connection', returnTo: 'https://evil.example/x' })).toBe(
      '/weldmerge/settings?tab=providers',
    );
    expect(resolveReturnTo({ purpose: 'connection', returnTo: '//evil.example/x' })).toBe('/weldmerge/settings?tab=providers');
  });
});

describe('WeldMerge OAuth callback page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the code and state once and returns to where the member started', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.mutate.mockImplementation((_input, options) => options.onSuccess(connected));
    render(<WeldMergeOauthCallbackPage code="abc" state="xyz" />);
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.mutate.mock.calls[0]?.[0]).toEqual({ code: 'abc', state: 'xyz' });
    expect(await screen.findByText('GitLab connected')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(state.replace).toHaveBeenCalledWith('/weldmerge/settings?tab=providers');
    vi.useRealTimers();
  });

  it('shows an error when the provider sent no code', () => {
    render(<WeldMergeOauthCallbackPage state="xyz" />);
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(en.weldmerge.sync.oauth.errorMissing)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.weldmerge.sync.oauth.backToSettings })).toBeTruthy();
  });

  it('shows why when the member denied access', () => {
    render(<WeldMergeOauthCallbackPage error="access_denied" errorDescription="The user denied the request" />);
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/The user denied the request/)).toBeTruthy();
  });

  it('shows an error when the server refuses the exchange', async () => {
    state.mutate.mockImplementation((_input, options) => options.onError(new Error('expired')));
    render(<WeldMergeOauthCallbackPage code="abc" state="xyz" />);
    expect(await screen.findByText(en.weldmerge.sync.oauth.errorFailed)).toBeTruthy();
    expect(state.replace).not.toHaveBeenCalled();
  });

  it('asks which Azure DevOps organisation to use when there are several', async () => {
    state.mutate.mockImplementation((_input, options) =>
      options.onSuccess({
        purpose: 'connection',
        provider: 'azure_devops',
        returnTo: null,
        connectionId: 'mcn_9',
        accountId: null,
        organizations: [
          { name: 'acme', url: 'https://dev.azure.com/acme' },
          { name: 'acme-labs', url: 'https://dev.azure.com/acme-labs' },
        ],
      }),
    );
    render(<WeldMergeOauthCallbackPage code="abc" state="xyz" />);
    await waitFor(() => expect(screen.getByText(en.weldmerge.sync.azureOrganization.title)).toBeTruthy());
    expect(state.replace).not.toHaveBeenCalled();
  });
});
