import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { makeLive } from '../observe-fixtures';
import { LivePanel, tally } from './live-panel';

const state = vi.hoisted(() => ({
  perms: new Set<string>(),
  live: { data: undefined as unknown, error: null as unknown, isLoading: false, refetch: vi.fn(), dataUpdatedAt: 0 },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({ useWeldPanelLive: () => state.live }));

const tl = en.weldpanel.observe.live;

describe('LivePanel', () => {
  beforeEach(() => {
    state.perms = new Set();
    state.live = { data: makeLive(), error: null, isLoading: false, refetch: vi.fn(), dataUpdatedAt: Date.parse('2026-11-14T10:00:00Z') };
  });

  it('counts visitors and tallies pages, countries and devices', () => {
    render(<LivePanel projectId="wpp_1" />);
    expect(screen.getByText(tl.visitors).closest('[data-slot=card]')?.textContent).toContain('2');
    // Two sessions are on /pricing.
    expect(screen.getAllByText('/pricing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Netherlands')).toHaveLength(2);
    expect(screen.getAllByText('Germany')).toHaveLength(2);
    expect(screen.getByText('Mobile')).toBeTruthy();
  });

  it('shows pseudonymised ids as anonymous visitors unless profiles may be seen', () => {
    const { unmount } = render(<LivePanel projectId="wpp_1" />);
    expect(screen.getByText('Anonymous visitor 111111')).toBeTruthy();
    expect(screen.getByText(tl.pseudonymised)).toBeTruthy();
    unmount();
    state.perms = new Set(['panel_people:read']);
    render(<LivePanel projectId="wpp_1" />);
    expect(screen.getByText('anon_aaaaaa111111')).toBeTruthy();
  });

  it('says it is quiet when nobody is on the site', () => {
    state.live.data = makeLive({ visitors: 0, sessions: [] });
    render(<LivePanel projectId="wpp_1" />);
    expect(screen.getByText(tl.quiet)).toBeTruthy();
  });

  it('can be compact, without the session table', () => {
    render(<LivePanel projectId="wpp_1" compact />);
    expect(screen.queryByText(tl.sessions)).toBeNull();
  });

  it('shows an error with a retry', () => {
    state.live = { ...state.live, data: undefined, error: new ApiError('boom', 500) };
    render(<LivePanel projectId="wpp_1" />);
    expect(screen.getByText(en.weldpanel.analytics.errors.loadFailed)).toBeTruthy();
  });

  it('tallies biggest first and skips empty keys', () => {
    expect(tally(['a', 'b', 'b', '', 'c'], (v) => v || null)).toEqual([
      { value: 'b', count: 2 },
      { value: 'a', count: 1 },
      { value: 'c', count: 1 },
    ]);
  });
});
