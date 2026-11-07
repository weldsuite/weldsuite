import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { MergeConnectionDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { ProviderCard } from './provider-card';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

function connection(overrides: Partial<MergeConnectionDto> = {}): MergeConnectionDto {
  return {
    id: 'mcn_1',
    provider: 'gitlab',
    externalAccountId: '1',
    accountLogin: 'acme',
    accountType: 'group',
    host: null,
    status: 'active',
    credentialsExpireAt: null,
    oauthUserLogin: null,
    repositoryCount: 3,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(props: Partial<Parameters<typeof ProviderCard>[0]> = {}) {
  const handlers = {
    onConnect: vi.fn(),
    onConnectSelfManaged: vi.fn(),
    onReconnect: vi.fn(),
    onDisconnect: vi.fn(),
    onAddRepositories: vi.fn(),
  };
  render(<ProviderCard provider="gitlab" connections={[]} canManage busy={false} {...handlers} {...props} />);
  return handlers;
}

describe('ProviderCard', () => {
  it('offers to connect when there is no connection, and the self-managed route for GitLab', () => {
    const handlers = setup();
    expect(screen.getByText(en.weldmerge.sync.providers.noConnection)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitLab' }));
    expect(handlers.onConnect).toHaveBeenCalledWith('gitlab');
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.sync.providers.connectSelfManaged }));
    expect(handlers.onConnectSelfManaged).toHaveBeenCalledTimes(1);
  });

  it('does not offer self-managed for the other providers', () => {
    setup({ provider: 'bitbucket' });
    expect(screen.queryByRole('button', { name: en.weldmerge.sync.providers.connectSelfManaged })).toBeNull();
  });

  it('shows a connected account with add repositories and disconnect', () => {
    const handlers = setup({ connections: [connection()] });
    expect(screen.getByText('acme · 3 repositories')).toBeTruthy();
    expect(screen.getByText(en.weldmerge.settings.providers.status.active)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.weldmerge.sync.providers.reconnect })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.sync.providers.addRepositories }));
    expect(handlers.onAddRepositories).toHaveBeenCalledWith(expect.objectContaining({ id: 'mcn_1' }));
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.sync.providers.disconnect }));
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('shows a reconnect action instead of add repositories when the connection needs attention', () => {
    const handlers = setup({ connections: [connection({ status: 'needs_attention' })] });
    expect(screen.getByText(en.weldmerge.settings.providers.status.needs_attention)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.weldmerge.sync.providers.addRepositories })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.sync.providers.reconnect }));
    expect(handlers.onReconnect).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs_attention' }));
  });

  it('flags an Azure DevOps connection that has no organisation yet', () => {
    setup({ provider: 'azure_devops', connections: [connection({ provider: 'azure_devops', accountLogin: null, host: null })] });
    expect(screen.getByText(/No organisation chosen yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.weldmerge.sync.providers.reconnect })).toBeTruthy();
  });

  it('shows the self-managed host of a GitLab connection', () => {
    setup({ connections: [connection({ host: 'https://git.example.com' })] });
    expect(screen.getByText('Self-managed at https://git.example.com')).toBeTruthy();
  });

  it('is read-only without the manage permission', () => {
    setup({ canManage: false, connections: [connection()] });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('allows only one GitHub connection', () => {
    setup({ provider: 'github', connections: [connection({ provider: 'github' })] });
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
  });
});
