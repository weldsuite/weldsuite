import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeUsage } from '../observe-fixtures';
import { UsageBanner } from './usage-banner';

const state = vi.hoisted(() => ({
  perms: new Set<string>(['panel_projects:manage']),
  usage: { data: undefined as unknown },
  enabledArgs: [] as boolean[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/lib/router', () => ({ Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelUsage: (enabled: boolean) => {
    state.enabledArgs.push(enabled);
    return state.usage;
  },
}));

const tb = en.weldpanel.observe.banner;
const meter = (used: number, allowance: number) => ({ used, allowance, blocksCharged: 0, creditsCharged: 0 });

describe('UsageBanner', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_projects:manage']);
    state.usage = { data: makeUsage() };
    state.enabledArgs = [];
    window.sessionStorage.clear();
  });

  it('is silent while usage is comfortable', () => {
    render(<UsageBanner />);
    expect(screen.queryByTestId('weldpanel-usage-banner')).toBeNull();
  });

  it('warns at 80% with the share used and links to usage, top-up and upgrade', () => {
    state.usage = { data: makeUsage({ events: meter(850_000, 1_000_000) }) };
    render(<UsageBanner />);
    expect(screen.getByText(tb.warning80.replace('{percent}', '85%').replace('{what}', tb.what.events))).toBeTruthy();
    expect(screen.getByRole('link', { name: tb.viewUsage }).getAttribute('href')).toBe('/weldpanel/settings?tab=usage');
    expect(screen.getByRole('link', { name: tb.topUp }).getAttribute('href')).toBe('/settings/billing');
    expect(screen.getByRole('link', { name: tb.upgrade }).getAttribute('href')).toBe('/settings/plans');
  });

  it('says the allowance is reached at 100%', () => {
    state.usage = { data: makeUsage({ recordings: meter(5000, 5000) }) };
    render(<UsageBanner />);
    expect(screen.getByText(tb.reached100.replace('{what}', tb.what.recordings))).toBeTruthy();
  });

  it('alerts while events are dropped or recording is paused, and cannot be dismissed', () => {
    state.usage = { data: makeUsage({ quota: 'events_blocked' }) };
    const { unmount } = render(<UsageBanner />);
    expect(screen.getByText(tb.eventsBlocked)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /dismiss|close/i })).toBeNull();
    unmount();
    state.usage = { data: makeUsage({ quota: 'replay_blocked' }) };
    render(<UsageBanner />);
    expect(screen.getByText(tb.replayBlocked)).toBeTruthy();
  });

  it('lets a warning be dismissed for the session', async () => {
    state.usage = { data: makeUsage({ events: meter(850_000, 1_000_000) }) };
    const { unmount } = render(<UsageBanner />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss|close/i }));
    expect(screen.queryByTestId('weldpanel-usage-banner')).toBeNull();
    unmount();
    render(<UsageBanner />);
    expect(screen.queryByTestId('weldpanel-usage-banner')).toBeNull();
  });

  it('shows only to people who manage WeldPanel, and does not even ask for the usage otherwise', () => {
    state.perms = new Set();
    state.usage = { data: makeUsage({ quota: 'events_blocked' }) };
    render(<UsageBanner />);
    expect(screen.queryByTestId('weldpanel-usage-banner')).toBeNull();
    expect(state.enabledArgs.every((enabled) => enabled === false)).toBe(true);
  });
});
