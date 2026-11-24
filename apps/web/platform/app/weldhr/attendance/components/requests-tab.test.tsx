import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHrFormatLocale } from '@/app/weldhr/components/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrShiftRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { RequestsTab } from './requests-tab';
import { latest } from '@/components/panel-entity-list-test-mock';

const t = en.weldhr.attendance.requests;

interface QueryResult {
  data: HrShiftRequest[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  canReview: true,
  pending: undefined as unknown,
  reviewed: undefined as unknown,
  pendingLoading: false,
  reviewedLoading: false,
  pendingError: null as Error | null,
  reviewedError: null as Error | null,
  refetchPending: vi.fn(),
  refetchReviewed: vi.fn(),
  review: vi.fn(),
  reviewPending: false,
  reviewVariables: undefined as { id: string } | undefined,
  filters: [] as unknown[],
  openPanel: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (p: string) => p === 'attendance:create' && state.canReview }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: state.openPanel }) }));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('./shift-request-decline-dialog', () => ({
  ShiftRequestDeclineDialog: (p: {
    request: { id: string };
    summary: string;
    onConfirm: (note: string | null) => Promise<boolean>;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="decline">
      <p>{p.summary}</p>
      <button
        onClick={() =>
          void p.onConfirm('Too short notice').then((ok) => {
            if (ok) p.onClose();
          })
        }
      >
        confirm decline
      </button>
      <button onClick={p.onClose}>close decline</button>
    </div>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrShiftRequests: (params: { status: string; from?: string }): QueryResult => {
    state.filters.push(params);
    return params.status === 'pending'
      ? { data: state.pending as HrShiftRequest[] | undefined, isLoading: state.pendingLoading, error: state.pendingError, refetch: state.refetchPending }
      : { data: state.reviewed as HrShiftRequest[] | undefined, isLoading: state.reviewedLoading, error: state.reviewedError, refetch: state.refetchReviewed };
  },
  useReviewHrShiftRequest: () => ({ mutateAsync: state.review, isPending: state.reviewPending, variables: state.reviewVariables }),
}));

function shiftRequest(over: Partial<HrShiftRequest> & { id: string }): HrShiftRequest {
  return {
    employeeId: 'emp_1',
    employeeName: 'Anna de Vries',
    openShiftId: null,
    startsAt: '2026-11-25T09:00:00',
    endsAt: '2026-11-25T17:30:00',
    workType: 'Cashier',
    note: 'Happy to help',
    status: 'pending',
    shiftId: null,
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: '2026-11-20T08:00:00',
    ...over,
  };
}

function renderTab() {
  return render(
    <I18nProvider initialLanguage="en">
      <RequestsTab />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00'));
  state.canReview = true;
  state.pendingLoading = false;
  state.reviewedLoading = false;
  state.pendingError = null;
  state.reviewedError = null;
  state.reviewPending = false;
  state.reviewVariables = undefined;
  state.filters = [];
  state.refetchPending.mockReset().mockResolvedValue(undefined);
  state.refetchReviewed.mockReset().mockResolvedValue(undefined);
  state.review.mockReset().mockResolvedValue(undefined);
  state.openPanel.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
  state.pending = [
    shiftRequest({ id: 'sr_late', employeeName: 'Bram Jansen', startsAt: '2026-11-27T09:00:00', endsAt: '2026-11-27T12:00:00', workType: null, note: null }),
    shiftRequest({ id: 'sr_soon' }),
  ];
  state.reviewed = [
    shiftRequest({ id: 'sr_ok', employeeName: 'Carla Smit', status: 'approved', reviewedByName: 'Eva', reviewNote: 'See you then' }),
    shiftRequest({ id: 'sr_no', employeeName: 'Dirk Visser', status: 'rejected', reviewedByName: null, reviewNote: 'Full' }),
    shiftRequest({ id: 'sr_bare', employeeName: 'Emma Bakker', status: 'approved' }),
  ];
});

afterEach(() => vi.useRealTimers());

// The dates below read as WeldHR writes them in en-GB, whatever the machine's locale.
beforeAll(() => setHrFormatLocale('en-GB'));
afterAll(() => setHrFormatLocale(undefined));

describe('attendance RequestsTab', () => {
  it('asks for the pending queue and for the answers of the last 30 days', () => {
    renderTab();
    expect(state.filters).toContainEqual({ status: 'pending' });
    expect(state.filters).toContainEqual({ status: 'approved,rejected', from: '2026-10-24' });
  });

  it('lists the pending requests soonest first, above the reviewed ones', () => {
    renderTab();
    const pending = within(screen.getByRole('region', { name: t.groups.pending }));
    const ids = pending.getAllByTestId(/^row-/).map((row) => row.dataset.testid);
    expect(ids).toEqual(['row-sr_soon', 'row-sr_late']);
    const reviewed = within(screen.getByRole('region', { name: t.groups.reviewed }));
    expect(reviewed.getAllByTestId(/^row-/)).toHaveLength(3);
  });

  it('shows the day, time range, length, work type and note of a request', () => {
    renderTab();
    const row = within(screen.getByTestId('row-sr_soon'));
    expect(row.getAllByText(/Wed,? 25 Nov 2026|Wed 25 Nov 2026|25 Nov 2026/).length).toBeGreaterThan(0);
    expect(row.getAllByText(/09:00 – 17:30/).length).toBeGreaterThan(0);
    expect(row.getAllByText('Cashier').length).toBeGreaterThan(0);
    expect(row.getAllByText('Happy to help').length).toBeGreaterThan(0);
  });

  it('shows dashes for a request without a work type or note', () => {
    renderTab();
    const row = within(screen.getByTestId('row-sr_late'));
    expect(row.getAllByText('—')).toHaveLength(2);
  });

  it('shows who answered and the note as the status tooltip', () => {
    renderTab();
    const approved = screen.getByTestId('row-sr_ok').querySelector('[data-column="status"] span[title]');
    expect(approved).toHaveAttribute('title', `${t.table.reviewer}: Eva — See you then`);
    const rejected = screen.getByTestId('row-sr_no').querySelector('[data-column="status"] span[title]');
    expect(rejected).toHaveAttribute('title', 'Full');
    expect(screen.getByTestId('row-sr_bare').querySelector('[data-column="status"] span[title]')).toBeNull();
  });

  it('shows the loading state while either list loads', () => {
    state.reviewedLoading = true;
    renderTab();
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('shows the error of either list', () => {
    state.reviewedError = new Error('Reviewed failed');
    const { unmount } = renderTab();
    expect(screen.getByRole('alert')).toHaveTextContent('Reviewed failed');
    unmount();
    state.pendingError = new Error('Pending failed');
    renderTab();
    expect(screen.getByRole('alert')).toHaveTextContent('Pending failed');
  });

  it('shows the empty state when there are no requests at all', () => {
    state.pending = undefined;
    state.reviewed = undefined;
    renderTab();
    expect(screen.getByText(t.empty.title)).toBeInTheDocument();
  });

  it('opens the request panel from a row', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: 'open sr_ok' }));
    expect(state.openPanel).toHaveBeenCalledWith({ type: 'hr_shift_request', id: 'sr_ok' });
  });

  it('searches by employee, work type and note', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderTab();
    await user.type(screen.getByLabelText('search'), 'carla');
    expect(screen.getByTestId('row-sr_ok')).toBeInTheDocument();
    expect(screen.queryByTestId('row-sr_soon')).not.toBeInTheDocument();
  });

  it('filters by status and employee', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: 'status=rejected' }));
    expect(screen.getByTestId('row-sr_no')).toBeInTheDocument();
    expect(screen.queryByTestId('row-sr_ok')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'employee=Anna de Vries' }));
    expect(screen.getByTestId('row-sr_soon')).toBeInTheDocument();
    expect(screen.queryByTestId('row-sr_no')).not.toBeInTheDocument();
  });

  describe('review', () => {
    it('approves a request and confirms it went on the schedule', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-sr_soon')).getByRole('button', { name: t.approve }));
      expect(state.review).toHaveBeenCalledWith({ id: 'sr_soon', decision: 'approved', note: null });
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.approvedToast));
    });

    it('shows the server reason and refetches both lists when approving fails', async () => {
      vi.useRealTimers();
      state.review.mockRejectedValue(new Error('Already answered'));
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-sr_soon')).getByRole('button', { name: t.approve }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Already answered'));
      expect(toast.success).not.toHaveBeenCalled();
      expect(state.refetchPending).toHaveBeenCalled();
      expect(state.refetchReviewed).toHaveBeenCalled();
    });

    it('falls back to a general message when the failure has no reason', async () => {
      vi.useRealTimers();
      state.review.mockRejectedValue('x');
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-sr_soon')).getByRole('button', { name: t.approve }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.reviewFailed));
    });

    it('declines with the note from the dialog, without a success toast', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-sr_soon')).getByRole('button', { name: t.decline }));
      const dialog = screen.getByRole('dialog', { name: 'decline' });
      expect(within(dialog).getByText(/09:00 – 17:30/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'confirm decline' }));
      await waitFor(() => expect(state.review).toHaveBeenCalledWith({ id: 'sr_soon', decision: 'rejected', note: 'Too short notice' }));
      expect(toast.success).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'decline' })).not.toBeInTheDocument());
    });

    it('keeps the decline dialog open when declining fails', async () => {
      vi.useRealTimers();
      state.review.mockRejectedValue(new Error('Nope'));
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-sr_soon')).getByRole('button', { name: t.decline }));
      await user.click(screen.getByRole('button', { name: 'confirm decline' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nope'));
      expect(screen.getByRole('dialog', { name: 'decline' })).toBeInTheDocument();
    });

    it('closes the decline dialog without answering', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-sr_soon')).getByRole('button', { name: t.decline }));
      await user.click(screen.getByRole('button', { name: 'close decline' }));
      expect(screen.queryByRole('dialog', { name: 'decline' })).not.toBeInTheDocument();
      expect(state.review).not.toHaveBeenCalled();
    });

    it('only offers the buttons for pending requests', () => {
      renderTab();
      expect(within(screen.getByTestId('row-sr_ok')).queryByRole('button', { name: t.approve })).not.toBeInTheDocument();
      expect(within(screen.getByTestId('row-sr_late')).getByRole('button', { name: t.decline })).toBeInTheDocument();
    });

    it('has no buttons without permission to add shifts', () => {
      state.canReview = false;
      renderTab();
      expect(screen.queryByRole('button', { name: t.approve })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t.decline })).not.toBeInTheDocument();
    });

    it('disables the buttons while a review runs and spins on the row being answered', () => {
      state.reviewPending = true;
      state.reviewVariables = { id: 'sr_soon' };
      renderTab();
      const row = within(screen.getByTestId('row-sr_soon'));
      expect(row.getByRole('button', { name: t.approve })).toBeDisabled();
      expect(row.getByRole('button', { name: t.decline })).toBeDisabled();
      expect(row.getByRole('button', { name: t.approve }).querySelector('svg.animate-spin')).not.toBeNull();
      expect(within(screen.getByTestId('row-sr_late')).getByRole('button', { name: t.approve }).querySelector('svg.animate-spin')).toBeNull();
    });
  });

  it('leaves the rows alone for a filter without a value or on an unknown field', () => {
    renderTab();
    const rows = [...(state.pending as unknown[]), ...(state.reviewed as unknown[])] as never[];
    expect(latest.applyFilters?.(rows, [{ id: 'a', field: 'status', operator: 'is', value: '' }])).toHaveLength(rows.length);
    expect(latest.applyFilters?.(rows, [{ id: 'b', field: 'unknown', operator: 'is', value: 'x' }])).toHaveLength(rows.length);
  });
});
