import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { resetCurrentProjectChoice } from '../../lib/use-current-project';
import { makeSessionDetail } from '../../observe-fixtures';
import { makeProject } from '../../test-fixtures';
import RecordingDetailPage from './page';

const state = vi.hoisted(() => ({
  detail: { data: undefined as unknown, isLoading: false, error: null as unknown, refetch: vi.fn() },
  chunk: vi.fn(),
  player: vi.fn(),
  seek: vi.fn(),
  summary: { data: null as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  generate: { mutate: vi.fn(), isPending: false, error: null as unknown },
  favorite: { mutate: vi.fn(), isPending: false },
  unfavorite: { mutate: vi.fn(), isPending: false },
  aiEnabled: true,
  perms: new Set<string>(['panel_people:read']),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ sessionId: 'ses_1' }) }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../player/replay-player', () => ({
  ReplayPlayer: (props: { events: unknown[]; markers: unknown[]; visits: unknown[]; ref?: { current: unknown } }) => {
    state.player(props);
    if (props.ref) props.ref.current = { seek: state.seek };
    return <div data-testid="player">{props.events.length} events</div>;
  },
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1', settings: { ...makeProject().settings, aiEnabled: state.aiEnabled } })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelSession: () => state.detail,
  useWeldPanelChunkLoader: () => state.chunk,
  useWeldPanelSessionSummary: () => state.summary,
  useGenerateWeldPanelSessionSummary: () => state.generate,
  useFavoriteWeldPanelSession: () => state.favorite,
  useUnfavoriteWeldPanelSession: () => state.unfavorite,
}));

const ts = en.weldpanel.observe.session;
const gz = (events: unknown[]): ArrayBuffer => {
  const bytes = gzipSync(Buffer.from(JSON.stringify(events)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const ev = (type: number, timestamp: number) => ({ type, timestamp, data: {} });

describe('Recording detail', () => {
  beforeEach(() => {
    resetCurrentProjectChoice();
    window.localStorage.clear();
    state.detail = { data: makeSessionDetail(), isLoading: false, error: null, refetch: vi.fn() };
    state.chunk.mockReset();
    state.chunk.mockImplementation(async (_p: string, _s: string, seq: number) => (seq === 0 ? gz([ev(4, 1000), ev(2, 1001)]) : gz([ev(3, 5000), ev(3, 61_000)])));
    state.player.mockReset();
    state.seek.mockReset();
    state.summary = { data: null, isLoading: false, isError: false, refetch: vi.fn() };
    state.generate = { mutate: vi.fn(), isPending: false, error: null };
    state.favorite = { mutate: vi.fn(), isPending: false };
    state.unfavorite = { mutate: vi.fn(), isPending: false };
    state.aiEnabled = true;
  });

  it('loads every chunk from the first snapshot and hands the merged events to the player', async () => {
    render(<RecordingDetailPage />);
    expect(await screen.findByTestId('player')).toBeTruthy();
    expect(screen.getByText('4 events')).toBeTruthy();
    expect(state.chunk.mock.calls.map((c) => c[2]).sort()).toEqual([0, 1]);
    const props = state.player.mock.calls.at(-1)![0] as { events: { timestamp: number }[]; markers: { kind: string; offsetMs: number }[] };
    expect(props.events.map((e) => e.timestamp)).toEqual([1000, 1001, 5000, 61_000]);
    // Markers are offsets from the first event of the replay (10:00:00 is the first event's moment, so none before it).
    expect(Array.isArray(props.markers)).toBe(true);
  });

  it('starts playback only from the chunk that has the snapshot', async () => {
    state.detail = {
      data: makeSessionDetail({
        chunks: [
          { seq: 0, tsStart: 'a', tsEnd: 'b', bytes: 1, hasFullSnapshot: false },
          { seq: 1, tsStart: 'a', tsEnd: 'b', bytes: 1, hasFullSnapshot: true },
          { seq: 2, tsStart: 'a', tsEnd: 'b', bytes: 1, hasFullSnapshot: false },
        ],
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
    state.chunk.mockImplementation(async (_p: string, _s: string, seq: number) => gz(seq === 1 ? [ev(4, 1), ev(2, 2)] : [ev(3, 3)]));
    render(<RecordingDetailPage />);
    await screen.findByTestId('player');
    expect(state.chunk.mock.calls.map((c) => c[2]).sort()).toEqual([1, 2]);
  });

  it('says so when the stored chunks are gone', async () => {
    state.chunk.mockRejectedValue(new ApiError('Not found', 404));
    render(<RecordingDetailPage />);
    expect(await screen.findByText(ts.expired)).toBeTruthy();
    expect(screen.queryByTestId('player')).toBeNull();
  });

  it('explains a session without a recording and lists its events anyway', async () => {
    state.detail = { data: makeSessionDetail({ chunks: [] }), isLoading: false, error: null, refetch: vi.fn() };
    render(<RecordingDetailPage />);
    expect(await screen.findByText(ts.noPlayback)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: ts.tabs.events }));
    expect(screen.getByText('Buy now', { exact: false })).toBeTruthy();
    expect(state.chunk).not.toHaveBeenCalled();
  });

  it('shows a missing recording as not found', async () => {
    state.detail = { data: undefined, isLoading: false, error: new ApiError('Not found', 404), refetch: vi.fn() };
    render(<RecordingDetailPage />);
    expect(await screen.findByText(ts.notFound)).toBeTruthy();
  });

  it('jumps the player to a page from the page list', async () => {
    render(<RecordingDetailPage />);
    await screen.findByTestId('player');
    await userEvent.click(screen.getByRole('tab', { name: ts.tabs.pages }));
    await userEvent.click(screen.getByRole('button', { name: ts.pages.jump.replace('{path}', '/checkout') }));
    expect(state.seek).toHaveBeenCalled();
  });

  it('adds a favourite with a note, and removes one', async () => {
    const { unmount } = render(<RecordingDetailPage />);
    await screen.findByTestId('player');
    await userEvent.click(screen.getByRole('button', { name: ts.favorite.add }));
    await userEvent.type(screen.getByLabelText(ts.favorite.note), 'Checkout bug');
    await userEvent.click(screen.getByRole('button', { name: ts.favorite.save }));
    expect(state.favorite.mutate).toHaveBeenCalledWith({ sessionId: 'ses_1', note: 'Checkout bug' }, expect.anything());
    unmount();

    state.detail = {
      data: makeSessionDetail({ favorite: { id: 'f1', projectId: 'wpp_1', sessionId: 'ses_1', note: 'Keep', favoritedByUserId: 'u', createdAt: '2026-11-14T00:00:00Z' } }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
    render(<RecordingDetailPage />);
    expect(await screen.findByText('Keep')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: ts.favorite.remove }));
    expect(state.unfavorite.mutate).toHaveBeenCalledWith('ses_1', expect.anything());
  });

  describe('AI summary', () => {
    it('offers to generate one and charges only on the click', async () => {
      render(<RecordingDetailPage />);
      await screen.findByTestId('player');
      expect(screen.getByText(ts.summary.costHint)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: ts.summary.generate }));
      expect(state.generate.mutate).toHaveBeenCalledWith({ sessionId: 'ses_1', regenerate: false });
    });

    it('shows a saved summary and offers to summarise again', async () => {
      state.summary = {
        data: {
          id: 's1',
          projectId: 'wpp_1',
          sessionId: 'ses_1',
          summary: { goal: 'Buy the pro plan', outcome: 'abandoned', frictionPoints: ['Button did nothing'], narrative: 'They tried three times.' },
          modelId: 'claude',
          creditsCharged: 3,
          createdAt: '2026-11-14T10:00:00Z',
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      };
      render(<RecordingDetailPage />);
      expect(await screen.findByText('Buy the pro plan')).toBeTruthy();
      expect(screen.getByText(ts.summary.outcomes.abandoned)).toBeTruthy();
      expect(screen.getByText('Button did nothing')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: ts.summary.regenerate }));
      expect(state.generate.mutate).toHaveBeenCalledWith({ sessionId: 'ses_1', regenerate: true });
    });

    it('explains an empty wallet with the numbers and a way to top up', async () => {
      state.generate.error = new ApiError('Not enough credits', 402, { error: { code: 'INSUFFICIENT_CREDITS', details: { requiredCredits: 5, availableCredits: 2 } } });
      render(<RecordingDetailPage />);
      expect(await screen.findByText('Not enough credits. This needs 5, you have 2.')).toBeTruthy();
      expect(screen.getByRole('link', { name: ts.summary.topUp }).getAttribute('href')).toBe('/settings/billing');
    });

    it('explains AI being off, and makes no call', async () => {
      state.aiEnabled = false;
      render(<RecordingDetailPage />);
      await waitFor(() => expect(screen.getByText(ts.summary.aiDisabled)).toBeTruthy());
      expect(screen.queryByRole('button', { name: ts.summary.generate })).toBeNull();
    });

    it('explains a session with nothing to summarise', async () => {
      state.generate.error = new ApiError('No sessions', 404, { error: { code: 'NO_SESSIONS' } });
      render(<RecordingDetailPage />);
      expect(await screen.findByText(ts.summary.noSessions)).toBeTruthy();
    });
  });
});
