import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { makeUsage } from '../observe-fixtures';
import { parseSettingsSearch } from './search';
import WeldPanelSettingsPage from './page';

const state = vi.hoisted(() => ({
  perms: new Set<string>(['panel_projects:manage']),
  usage: { data: undefined as unknown, isLoading: false, error: null as unknown, refetch: vi.fn(), isFetching: false },
  search: {} as Record<string, unknown>,
  replace: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@tanstack/react-router', () => ({ useSearch: () => state.search }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: state.replace }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({ useWeldPanelUsage: () => state.usage }));

const tu = en.weldpanel.observe.usage;
const ok = (data = makeUsage()) => ({ data, isLoading: false, error: null, refetch: vi.fn().mockResolvedValue({}), isFetching: false });

describe('WeldPanel settings: usage', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_projects:manage']);
    state.usage = ok();
    state.search = { tab: 'usage' };
    state.replace.mockReset();
    state.toast.success.mockReset();
  });

  it('shows events and recordings against the allowance, for the whole workspace', () => {
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText('400,000 of 1,000,000')).toBeTruthy();
    expect(screen.getByText('1,000 of 5,000')).toBeTruthy();
    expect(screen.getAllByText('40% of your allowance').length).toBe(1);
    expect(screen.getByText('Marketing site')).toBeTruthy();
    expect(screen.getByText('Plan: business')).toBeTruthy();
    expect(screen.getByText('November 2026')).toBeTruthy();
    expect(screen.getByText('Events: 25 months')).toBeTruthy();
    expect(screen.getByText('Recordings: 30 days')).toBeTruthy();
    expect(screen.getByText(tu.quotas.ok)).toBeTruthy();
  });

  it('shows the overage charged beyond the allowance', () => {
    state.usage = ok(makeUsage({ events: { used: 1_050_000, allowance: 1_000_000, blocksCharged: 5, creditsCharged: 50 } }));
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText(tu.overAllowance)).toBeTruthy();
    expect(screen.getByText('5 blocks charged, 50 credits')).toBeTruthy();
  });

  it('explains dropped events and offers a top-up and a re-check that lifts the block', async () => {
    const refetch = vi.fn().mockResolvedValue({});
    state.usage = { ...ok(makeUsage({ quota: 'events_blocked' })), refetch };
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText(tu.quotas.events_blocked)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: tu.topUp })[0]!.getAttribute('href')).toBe('/settings/billing');
    expect(screen.getByRole('link', { name: tu.upgrade }).getAttribute('href')).toBe('/settings/plans');
    await userEvent.click(screen.getByRole('button', { name: tu.refresh }));
    expect(refetch).toHaveBeenCalled();
    await vi.waitFor(() => expect(state.toast.success).toHaveBeenCalledWith(tu.refreshed));
  });

  it('explains paused recording', () => {
    state.usage = ok(makeUsage({ quota: 'replay_blocked' }));
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText(tu.quotas.replay_blocked)).toBeTruthy();
  });

  it('shows a skeleton, an error with a retry, and an empty project list', async () => {
    state.usage = { ...ok(), data: undefined, isLoading: true };
    const first = render(<WeldPanelSettingsPage />);
    expect(screen.queryByText(tu.title)).toBeNull();
    first.unmount();

    const refetch = vi.fn();
    state.usage = { ...ok(), data: undefined, error: new ApiError('boom', 500), refetch };
    const second = render(<WeldPanelSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(refetch).toHaveBeenCalled();
    second.unmount();

    state.usage = ok(makeUsage({ projects: [] }));
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText(tu.noProjects)).toBeTruthy();
  });

  it('needs the manage permission', () => {
    state.perms = new Set();
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText(en.weldpanel.observe.settings.noPermission)).toBeTruthy();
    expect(screen.queryByText(tu.title)).toBeNull();
  });

  it('reads the tab from the URL, and falls back to usage for an unknown one', () => {
    expect(parseSettingsSearch({ tab: 'usage' })).toEqual({ tab: 'usage' });
    expect(parseSettingsSearch({ tab: 'nope' })).toEqual({});
    state.search = { tab: 'nope' };
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText(tu.title)).toBeTruthy();
  });
});
