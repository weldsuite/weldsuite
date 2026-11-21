import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { makeLive } from '../observe-fixtures';
import { LivePanel, sessionAverages, tally } from './live-panel';

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

  it('shows the visitors of the last 30 and 5 minutes and tallies countries, pages and devices', () => {
    render(<LivePanel projectId="wpp_1" />);
    expect(screen.getByText(tl.last30Note).parentElement?.textContent).toContain('2');
    expect(screen.getByText(tl.last5Note).parentElement?.textContent).toContain('2');
    // Two visitors are on /pricing.
    expect(screen.getAllByText('/pricing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Netherlands').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Germany').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mobile').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: tl.byCountry })).toBeTruthy();
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

  it('shows zeros and says it is quiet when nobody was on the site', () => {
    state.live.data = makeLive({ visitors: 0, visitors30m: 0, perMinute: Array.from({ length: 30 }, () => 0), sessions: [] });
    render(<LivePanel projectId="wpp_1" />);
    expect(screen.getAllByText(tl.noData)).toHaveLength(3);
    expect(screen.getByText(tl.quiet)).toBeTruthy();
  });

  it('shows an error with a retry', () => {
    state.live = { ...state.live, data: undefined, error: new ApiError('boom', 500) };
    render(<LivePanel projectId="wpp_1" />);
    expect(screen.getByText(en.weldpanel.analytics.errors.loadFailed)).toBeTruthy();
  });

  it('averages the time on site and the pages per visit', () => {
    expect(sessionAverages([])).toEqual({ seconds: 0, pages: 0 });
    const averages = sessionAverages([
      { startedAt: '2026-11-14T09:58:00.000Z', ts: '2026-11-14T10:00:00.000Z', pageviews: 3 },
      { startedAt: '2026-11-14T09:59:00.000Z', ts: '2026-11-14T10:00:00.000Z', pageviews: 1 },
    ]);
    expect(averages).toEqual({ seconds: 90, pages: 2 });
  });

  it('tallies visitors, not sessions, when given who each one is', () => {
    const sessions = [
      { page: '/a', who: 'v1' },
      { page: '/a', who: 'v1' },
      { page: '/a', who: 'v2' },
      { page: '/b', who: 'v1' },
    ];
    expect(tally(sessions, (s) => s.page, (s) => s.who)).toEqual([
      { value: '/a', count: 2 },
      { value: '/b', count: 1 },
    ]);
  });

  it('tallies biggest first and skips empty keys', () => {
    expect(tally(['a', 'b', 'b', '', 'c'], (v) => v || null)).toEqual([
      { value: 'b', count: 2 },
      { value: 'a', count: 1 },
      { value: 'c', count: 1 },
    ]);
  });
});
