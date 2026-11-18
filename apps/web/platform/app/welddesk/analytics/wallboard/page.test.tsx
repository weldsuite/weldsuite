/**
 * The wallboard: every block from one fixture, the phone block only when the
 * workspace has one, the stale state when a refresh fails, the team filter
 * going into the request, and realtime refetches thrown at most every 2 seconds.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DeskWallboard } from '@weldsuite/core-api-client/schemas/helpdesk-live-reports';

const state = vi.hoisted(() => ({
  query: {} as {
    data: unknown;
    isLoading: boolean;
    isError: boolean;
    refetch: () => Promise<unknown>;
  },
  team: null as string | null,
  boardArgs: [] as Array<[string | null]>,
  navigate: (() => undefined) as (options: unknown) => void,
  realtime: new Map<string, () => void>(),
}));

vi.mock('@/hooks/queries/use-desk-reports-queries', () => ({
  useDeskWallboard: (team: string | null) => {
    state.boardArgs.push([team]);
    return state.query;
  },
}));

vi.mock('@weldsuite/realtime/react', () => ({
  useRealtimeEvent: (topic: string, event: string, handler: () => void) => {
    state.realtime.set(`${topic}:${event}`, handler);
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => (options: unknown) => state.navigate(options),
}));

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
  useSearchParams: () => new URLSearchParams(state.team ? `team=${state.team}` : ''),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));

// A native select stands in for the Radix one, which needs a real layout.
vi.mock('@weldsuite/ui/components/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select aria-label="Team" value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

import DeskWallboardPage from './page';

function board(overrides: Partial<DeskWallboard> = {}): DeskWallboard {
  return {
    // In the future so the live wait never runs ahead of the fixture.
    generatedAt: new Date(Date.now() + 60_000).toISOString(),
    queue: { open: 41, unassigned: 7, waiting: 12, oldestWaitingSeconds: 300 },
    sla: {
      breached: 3,
      atRisk: 5,
      dueSoon: [
        {
          conversationId: 'dconv_soon',
          conversationNumber: 1042,
          name: 'Printer on fire',
          dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          metric: 'first_response',
          status: 'warning',
          assigneeName: 'Sam Support',
        },
        {
          conversationId: 'dconv_late',
          conversationNumber: 1001,
          name: null,
          dueAt: new Date(Date.now() - 2 * 60_000).toISOString(),
          metric: null,
          status: 'breached',
          assigneeName: null,
        },
      ],
    },
    today: { created: 23, resolved: 19, firstResponseMedianSeconds: 600 },
    teams: [
      { id: 'dept_a', name: 'Billing', open: 10, unassigned: 2, waiting: 3, breached: 1 },
      { id: 'dept_b', name: 'Technical', open: 31, unassigned: 5, waiting: 9, breached: 0 },
    ],
    agents: [
      { id: 'u1', name: 'Sam Support', open: 8, away: false },
      { id: 'u2', name: 'Alex Away', open: 2, away: true },
    ],
    phone: {
      waiting: 2,
      longestWaitSeconds: 95,
      availableAgents: 4,
      answeredToday: 31,
      missedToday: 6,
      abandonedToday: 3,
    },
    ...overrides,
  };
}

function loaded(data: DeskWallboard, extra: { isError?: boolean; refetch?: () => Promise<unknown> } = {}) {
  state.query = {
    data,
    isLoading: false,
    isError: extra.isError ?? false,
    refetch: extra.refetch ?? (() => Promise.resolve()),
  };
}

beforeEach(() => {
  state.team = null;
  state.boardArgs = [];
  state.navigate = () => undefined;
  state.realtime = new Map();
  loaded(board());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DeskWallboardPage', () => {
  it('renders every block from the fixture', () => {
    render(<DeskWallboardPage />);

    for (const label of [
      'Open',
      'Unassigned',
      'Waiting on us',
      'Longest wait',
      'SLA breached',
      'SLA at risk',
      'New today',
      'Resolved today',
      'First response (median)',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('41')).toBeTruthy();
    // 300 seconds, ticking from the time the numbers were generated.
    expect(screen.getByText('5:00')).toBeTruthy();
    expect(screen.getByText('10m')).toBeTruthy();

    // Due next: the countdown, the overdue row, the owner or "Unassigned", a link to the inbox.
    expect(screen.getByText('Due next')).toBeTruthy();
    expect(screen.getByText(/^in \d+:\d{2}$/)).toBeTruthy();
    expect(screen.getByText(/^overdue by \d+:\d{2}$/)).toBeTruthy();
    expect(screen.getByText('Printer on fire')).toBeTruthy();
    expect(screen.getByText('First response · Sam Support')).toBeTruthy();
    expect(screen.getByText('Unassigned', { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Printer on fire/ }).getAttribute('href')).toBe('/welddesk/inbox/dconv_soon');

    // Teams, agents (away marked), phone.
    const teams = within(screen.getByRole('table'));
    expect(teams.getByText('Billing')).toBeTruthy();
    expect(teams.getByText('Technical')).toBeTruthy();
    expect(screen.getByText('Alex Away')).toBeTruthy();
    expect(screen.getByText('Away')).toBeTruthy();
    expect(screen.getByText('8 open')).toBeTruthy();
    expect(screen.getByText('Phone')).toBeTruthy();
    expect(screen.getByText('Calls waiting')).toBeTruthy();
    expect(screen.getByText('Agents taking calls')).toBeTruthy();
    expect(screen.getByText('Abandoned today')).toBeTruthy();
    expect(screen.getByText('1:35')).toBeTruthy();
  });

  it('colours the SLA tiles only when above zero', () => {
    const { rerender } = render(<DeskWallboardPage />);
    const breached = () => screen.getByText('SLA breached').closest('[class*="rounded"]') as HTMLElement;
    expect(within(breached()).getByText('3').className).toContain('text-destructive');

    loaded(board({ sla: { breached: 0, atRisk: 0, dueSoon: [] } }));
    rerender(<DeskWallboardPage />);
    expect(within(breached()).getByText('0').className).not.toContain('text-destructive');
    expect(screen.getByText('No SLA clocks running.')).toBeTruthy();
  });

  it('hides the phone block when no number rings agents', () => {
    loaded(board({ phone: null }));
    render(<DeskWallboardPage />);
    expect(screen.queryByText('Calls waiting')).toBeNull();
    expect(screen.queryByText('Agents taking calls')).toBeNull();
  });

  it('keeps the last numbers and says so when a refresh fails', () => {
    loaded(board(), { isError: true });
    render(<DeskWallboardPage />);
    expect(screen.getByTestId('wallboard-stale').textContent).toContain('Connection lost. Showing the numbers from');
    expect(screen.getByText('41')).toBeTruthy();
  });

  it('shows an error with a way out only when there are no numbers at all', () => {
    state.team = 'dept_gone';
    state.query = { data: undefined, isLoading: false, isError: true, refetch: () => Promise.resolve() };
    const navigate = vi.fn();
    state.navigate = navigate;
    render(<DeskWallboardPage />);
    expect(screen.getByText('Failed to load the wallboard')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all teams' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/welddesk/reports/wallboard', search: {}, replace: true });
  });

  it('asks for the team in the URL and writes the chosen team back to it', () => {
    state.team = 'dept_b';
    const navigate = vi.fn();
    state.navigate = navigate;
    render(<DeskWallboardPage />);
    expect(state.boardArgs.at(-1)?.[0]).toBe('dept_b');

    const picker = screen.getByLabelText('Team') as HTMLSelectElement;
    expect(picker.value).toBe('dept_b');
    expect(within(picker).getByText('All teams')).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'dept_a' } });
    expect(navigate).toHaveBeenCalledWith({
      to: '/welddesk/reports/wallboard',
      search: { team: 'dept_a' },
      replace: true,
    });

    fireEvent.change(picker, { target: { value: '__all__' } });
    expect(navigate).toHaveBeenLastCalledWith({ to: '/welddesk/reports/wallboard', search: {}, replace: true });
  });

  it('goes full screen on its own root, which carries its own background', async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
    render(<DeskWallboardPage />);

    const root = screen.getByRole('heading', { name: 'Wallboard' }).closest('.bg-background');
    expect(root).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect((requestFullscreen.mock.contexts as unknown[])[0]).toBe(root);

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: root });
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeTruthy();

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  });

  it('refetches on realtime events, at most once every 2 seconds', () => {
    vi.useFakeTimers();
    const refetch = vi.fn(() => Promise.resolve());
    loaded(board(), { refetch });
    render(<DeskWallboardPage />);

    expect([...state.realtime.keys()].sort()).toEqual([
      'desk_conversation:created',
      'desk_conversation:updated',
      'desk_message:created',
      'desk_phone_queue:updated',
    ]);

    const fire = (key: string) => state.realtime.get(key)?.();
    act(() => {
      fire('desk_conversation:updated');
      fire('desk_phone_queue:updated');
      fire('desk_message:created');
    });
    // The first runs at once; the rest collapse into one at the end of the window.
    expect(refetch).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(refetch).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
