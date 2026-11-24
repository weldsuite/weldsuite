/** The vault trail labels the actions a phone adds (ADR PASS-010) and says when it happened offline. */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

const events = vi.hoisted(() => ({ data: [] as unknown[] }));

vi.mock('@weldsuite/i18n/client', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return {
    useTranslations: () => (key: string, params?: Record<string, unknown>) => {
      const value = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], locale);
      return String(value ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));
    },
  };
});
vi.mock('@/hooks/queries/use-weldpass-passwords-queries', () => ({
  useWeldPassVaultActivity: () => ({ data: events.data, isLoading: false, error: null }),
  useWeldPassVaultMembers: () => ({ data: [] }),
  useWeldPassTeammates: () => ({ data: [] }),
}));

import { VaultActivityPanel } from './vault-activity-panel';

const ta = en.weldpass.passwords.activity;

function event(id: string, action: string, metadata: Record<string, unknown> = {}) {
  return {
    id,
    vaultId: 'v1',
    actorId: 'user_1',
    actorName: 'Gert',
    action,
    targetLabel: null,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

describe('VaultActivityPanel', () => {
  it('labels phone actions and marks the offline ones', () => {
    events.data = [
      event('1', 'device.synced', { deviceId: 'wpd_1', full: false, items: 12, deleted: 0 }),
      event('2', 'item.copied', { offline: true }),
      event('3', 'item.autofilled', { offline: true }),
      event('4', 'item.revealed', { offline: true }),
      event('5', 'item.revealed'),
    ];
    render(<VaultActivityPanel vaultId="v1" />);

    expect(screen.getByText(ta.actions.device.synced, { exact: false })).toBeInTheDocument();
    expect(screen.getByText('· 12 items', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(ta.actions.item.copied, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(ta.actions.item.autofilled, { exact: false })).toBeInTheDocument();
    // Three offline events carry the note; the plain reveal does not.
    expect(screen.getAllByText(`· ${ta.offline}`)).toHaveLength(3);
  });
});
