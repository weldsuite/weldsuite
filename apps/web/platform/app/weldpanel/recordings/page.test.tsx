import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelSessionsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeSession } from '../observe-fixtures';
import { makeProject } from '../test-fixtures';
import RecordingsPage from './page';

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  perms: new Set<string>(['panel_recordings:read']),
  recordings: {
    data: undefined as unknown,
    error: null as unknown,
    isLoading: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  },
  specs: [] as PanelSessionsSpec[],
  replace: vi.fn(),
  push: vi.fn(),
  aiEnabled: true,
  summarise: { mutate: vi.fn(), reset: vi.fn(), isPending: false, data: undefined as unknown, error: null as unknown },
  favorite: vi.fn(),
  unfavorite: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => state.search }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: state.replace }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({
    data: [makeProject({ id: 'wpp_1', settings: { ...makeProject().settings, aiEnabled: state.aiEnabled } }), makeProject({ id: 'wpp_2', name: 'Other' })],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useWeldPanelRecordings: (spec: PanelSessionsSpec) => {
    state.specs.push(spec);
    return state.recordings;
  },
  useWeldPanelCohorts: () => ({ data: [{ id: 'coh_1', name: 'Power users' }] }),
  useWeldPanelLexicon: () => ({ data: undefined }),
  useFavoriteWeldPanelSession: () => ({ mutateAsync: state.favorite }),
  useUnfavoriteWeldPanelSession: () => ({ mutateAsync: state.unfavorite }),
  useSummariseWeldPanelSet: () => state.summarise,
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

const tr = en.weldpanel.observe.recordings;

/**
 * Adds a finished filter pill through the toolbar: "Filter" > field > (operator) > value.
 * Fields with one operator skip the condition step. The pill opens its value picker on a
 * timer; when the options are not there yet, open it by hand.
 */
async function addFilter(user: ReturnType<typeof userEvent.setup>, field: string, operator: string | null, value: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Filter' }));
  await user.click(await screen.findByRole('button', { name: field }));
  if (operator) await user.click(await screen.findByRole('button', { name: operator }));
  const option = await screen.findByRole('button', { name: value }, { timeout: 400 }).catch(async () => {
    await user.click(screen.getByRole('button', { name: `Select ${field.toLowerCase()}` }));
    return screen.findByRole('button', { name: value });
  });
  await user.click(option);
}
const lastSpec = () => state.specs[state.specs.length - 1]!;
const listWith = (sessions = [makeSession()], extra: Record<string, unknown> = {}) => ({
  data: { sessions, pages: [], dataAsOf: DATA_AS_OF },
  error: null,
  isLoading: false,
  isFetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  ...extra,
});

describe('Recordings list', () => {
  beforeEach(() => {
    state.search = {};
    state.perms = new Set(['panel_recordings:read']);
    state.recordings = listWith();
    state.specs = [];
    state.replace.mockReset();
    state.push.mockReset();
    state.favorite.mockReset().mockResolvedValue({ sessionId: 'ses_1' });
    state.unfavorite.mockReset().mockResolvedValue(undefined);
    state.aiEnabled = true;
    state.summarise = { mutate: vi.fn(), reset: vi.fn(), isPending: false, data: undefined, error: null };
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('asks for sessions with a recording, newest first', () => {
    render(<RecordingsPage />);
    expect(lastSpec()).toMatchObject({ kind: 'sessions', projectId: 'wpp_1', hasRecording: true, dateRange: { preset: '30d' }, sort: undefined });
  });

  it('lists each recording with its signals, device and favourite star, in standard rows', () => {
    state.recordings = listWith([
      makeSession({ sessionId: 'a', rageClicks: 3, errors: 1, favorite: true, userId: 'user_42' }),
      makeSession({ sessionId: 'b', distinctId: 'anon_zzzzzz999999' }),
    ]);
    render(<RecordingsPage />);
    expect(screen.getByText('user_42')).toBeTruthy();
    expect(screen.getByText('Anonymous visitor 999999')).toBeTruthy();
    expect(screen.getByText('3 Rage clicks')).toBeTruthy();
    expect(screen.getByText('1 Errors')).toBeTruthy();
    expect(screen.getByLabelText(tr.favorite)).toBeTruthy();
    expect(screen.getAllByText('Desktop · Chrome · Netherlands')).toHaveLength(2);
  });

  it('reads the filters from the URL, so a funnel link lands filtered', () => {
    state.search = { range: '7d', did: ['Checkout started'], didNot: ['Paid'], frustration: ['rage'], errors: true, countries: ['NL'] };
    render(<RecordingsPage />);
    expect(lastSpec()).toMatchObject({
      dateRange: { preset: '7d' },
      didEvents: ['Checkout started'],
      notDidEvents: ['Paid'],
      frustration: ['rage'],
      hasErrors: true,
      countries: ['NL'],
    });
    // Each filter is a pill in the toolbar.
    expect(screen.getByText(en.weldpanel.analytics.range['7d'])).toBeTruthy();
    expect(screen.getByText(tr.filters.frustrationTypes.rage)).toBeTruthy();
    expect(screen.getByText(tr.filters.errors)).toBeTruthy();
    expect(screen.getAllByText('Checkout started').length).toBeGreaterThan(0);
  });

  it('ignores a bad field in the URL instead of dropping every filter', () => {
    state.search = { minDuration: 'abc', errors: true };
    render(<RecordingsPage />);
    expect(lastSpec()).toMatchObject({ hasErrors: true });
    expect(lastSpec().minDurationSeconds).toBeUndefined();
  });

  it('writes a filter picked in the toolbar back to the URL', async () => {
    const user = userEvent.setup();
    render(<RecordingsPage />);
    await addFilter(user, tr.filters.devices, 'is', en.weldpanel.observe.common.devices.mobile);
    expect(decodeURIComponent(state.replace.mock.calls.at(-1)![0])).toContain('devices=["mobile"]');
  });

  it('drops a filter when its pill is removed', async () => {
    state.search = { pages: ['/pricing'], errors: true };
    render(<RecordingsPage />);
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    await userEvent.click(removes[0]!);
    const url = decodeURIComponent(state.replace.mock.calls.at(-1)![0]);
    expect(url).not.toContain('errors');
    expect(url).toContain('pages=["/pricing"]');
  });

  it('searches for a visitor once typing pauses', async () => {
    render(<RecordingsPage />);
    await userEvent.type(screen.getAllByRole('textbox', { name: tr.filters.userPlaceholder })[0]!, 'user_42');
    await vi.waitFor(() => expect(state.replace.mock.calls.at(-1)?.[0]).toContain('user=user_42'));
  });

  it('adds and removes favourites from the row menu', async () => {
    state.recordings = listWith([makeSession({ sessionId: 'ses_1', favorite: false })]);
    render(<RecordingsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
    await userEvent.click(await screen.findByRole('menuitem', { name: en.weldpanel.observe.session.favorite.add }));
    expect(state.favorite).toHaveBeenCalledWith({ sessionId: 'ses_1' });
  });

  it('opens a recording from its row', async () => {
    render(<RecordingsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.view }));
    expect(state.push).toHaveBeenCalledWith('/weldpanel/recordings/ses_1?project=wpp_1');
  });

  it('loads more when the end of the list scrolls into view', () => {
    const original = window.IntersectionObserver;
    class VisibleObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    window.IntersectionObserver = VisibleObserver as unknown as typeof IntersectionObserver;
    try {
      state.recordings = listWith([makeSession()], { hasNextPage: true });
      render(<RecordingsPage />);
      expect(state.recordings.fetchNextPage).toHaveBeenCalled();
    } finally {
      window.IntersectionObserver = original;
    }
  });

  describe('states', () => {
    it('shows the page loader while loading', () => {
      state.recordings = listWith([], { data: undefined, isLoading: true });
      render(<RecordingsPage />);
      expect(screen.getByText(en.common.labels.loading)).toBeTruthy();
    });

    it('distinguishes no recordings from no matches', () => {
      state.recordings = listWith([]);
      const { unmount } = render(<RecordingsPage />);
      expect(screen.getByText(tr.emptyTitle)).toBeTruthy();
      unmount();
      state.search = { errors: true };
      render(<RecordingsPage />);
      expect(screen.getByText(tr.emptyFilteredTitle)).toBeTruthy();
    });

    it('offers a retry when the query fails', async () => {
      state.recordings = listWith([], { data: undefined, error: new ApiError('boom', 500) });
      render(<RecordingsPage />);
      await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.errors.retry }));
      expect(state.recordings.refetch).toHaveBeenCalled();
    });

    it('needs the recordings permission', () => {
      state.perms = new Set();
      render(<RecordingsPage />);
      expect(screen.getByText(tr.noRecordingsPermission)).toBeTruthy();
      expect(state.specs).toHaveLength(0);
    });
  });

  describe('summarise these sessions', () => {
    it('runs the summary on the current filter, only after the click', async () => {
      state.search = { errors: true };
      render(<RecordingsPage />);
      await userEvent.click(screen.getByRole('button', { name: tr.summariseSet.button }));
      expect(state.summarise.mutate).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: tr.summariseSet.run }));
      const input = state.summarise.mutate.mock.calls[0]![0] as { projectId: string; limit: number; source: { type: string; spec: PanelSessionsSpec } };
      expect(input).toMatchObject({ projectId: 'wpp_1', limit: 20, source: { type: 'sessions', spec: { hasErrors: true } } });
    });

    it('shows the themes with an example to watch', async () => {
      state.summarise.data = {
        id: 'x',
        projectId: 'wpp_1',
        summary: { overview: 'Checkout confuses people.', themes: [{ title: 'Coupon field', description: 'Nobody finds it.', sessionIds: ['ses_9'], sessionCount: 7 }], sessionsRead: 12 },
        modelId: 'claude',
        creditsCharged: 12,
        cached: false,
        createdAt: DATA_AS_OF,
      };
      render(<RecordingsPage />);
      await userEvent.click(screen.getByRole('button', { name: tr.summariseSet.button }));
      expect(screen.getByText('Checkout confuses people.')).toBeTruthy();
      expect(screen.getByText('7 sessions')).toBeTruthy();
      expect(screen.getByText('12 credits charged', { exact: false })).toBeTruthy();
      expect(screen.getByRole('link', { name: tr.summariseSet.watch }).getAttribute('href')).toBe('/weldpanel/recordings/ses_9?project=wpp_1');
    });

    it('says when the wallet is short', async () => {
      state.summarise.error = new ApiError('x', 402, { error: { code: 'INSUFFICIENT_CREDITS', details: { requiredCredits: 20, availableCredits: 4 } } });
      render(<RecordingsPage />);
      await userEvent.click(screen.getByRole('button', { name: tr.summariseSet.button }));
      expect(screen.getByText('Not enough credits. This needs 20, you have 4.')).toBeTruthy();
    });

    it('is hidden where the project has AI off', () => {
      state.aiEnabled = false;
      render(<RecordingsPage />);
      expect(screen.queryByRole('button', { name: tr.summariseSet.button })).toBeNull();
    });
  });
});
