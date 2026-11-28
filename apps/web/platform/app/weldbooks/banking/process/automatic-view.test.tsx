import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankLine, BankLineLinks } from '@/lib/api/domains/weldbooks-banking';

const env = vi.hoisted(() => ({
  lines: [] as unknown[],
  links: {} as Record<string, unknown>,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  isError: false,
  isLoading: false,
  undo: vi.fn(),
  permissions: new Set<string>(['banking:update']),
  toast: { success: vi.fn(), error: vi.fn() },
  filters: [] as unknown[],
  questions: true,
  setReview: vi.fn(),
  reviewLines: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number) => `€${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useInfiniteBankLines: (filters: unknown) => {
    env.filters.push(filters);
    return {
      data: { lines: env.lines, totalCount: env.lines.length },
      isLoading: env.isLoading,
      isError: env.isError,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: env.fetchNextPage,
      refetch: vi.fn(),
    };
  },
  useBankLineLinks: (id: string) => ({ data: env.links[id] }),
}));
vi.mock('@/hooks/queries/use-weldbooks-questions-queries', () => ({
  isQuestionsAvailable: () => env.questions,
  useSetJournalEntryReview: () => ({ mutate: env.setReview, isPending: false }),
  useReviewBankLines: () => ({ mutate: env.reviewLines, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldbooks-processing-queries', () => ({
  useUndoBankLine: () => ({ mutate: env.undo, isPending: false }),
}));

import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '../components/test-utils';
import { AutomaticView } from './automatic-view';
import { automaticReasonLabel } from './process-model';

const line = (id: string, name: string, amount: string): BankLine =>
  ({ id, bankAccountId: 'ba_1', date: '2026-11-25', description: `${name} payment`, amount, counterpartyName: name, status: 'reconciled' }) as BankLine;

const withReason = (reason: BankLineLinks['reason'], rule: BankLineLinks['rule'] = null) => ({ automatic: true, reason, rule });

function renderView() {
  return renderWithProviders(<AutomaticView bankAccountId="ba_1" currency="EUR" />);
}

describe('AutomaticView', () => {
  beforeEach(() => {
    env.lines = [
      line('b1', 'Acme Logistics BV', '1210.00'),
      line('b2', 'Studio Noord BV', '-2500.00'),
      line('b3', 'Belastingdienst', '-640.00'),
      line('b4', 'Telnet Zakelijk', '-89.95'),
    ];
    env.links = {
      b1: withReason('document_match'),
      b2: withReason('own_account_transfer'),
      b3: withReason('tax_authority'),
      b4: withReason('rule', { id: 'rr_1', name: 'Telnet monthly' }),
    };
    env.hasNextPage = false;
    env.isError = false;
    env.isLoading = false;
    env.filters = [];
    env.questions = true;
    env.setReview.mockReset();
    env.reviewLines.mockReset();
    env.permissions = new Set(['banking:update']);
    env.undo.mockReset();
    env.fetchNextPage.mockReset();
    env.toast.success.mockReset();
    env.toast.error.mockReset();
    panelOpen.mockReset();
  });

  it('asks for the lines booked automatically on the chosen account', () => {
    renderView();
    expect(env.filters[0]).toEqual({ bankAccountId: 'ba_1', processedAutomatically: true });
  });

  it('shows the reason of every line as a translated chip, the rule by name', () => {
    renderView();
    const reason = (id: string) => within(screen.getByTestId(`automatic-line-${id}`)).getByTestId('automatic-reason');
    expect(reason('b1')).toHaveTextContent('Matched to a document');
    expect(reason('b2')).toHaveTextContent('Transfer between your own accounts');
    expect(reason('b3')).toHaveTextContent('Payment to the tax authority');
    expect(reason('b4')).toHaveTextContent('Rule: Telnet monthly');
  });

  it('opens a line as a stacked panel', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(within(screen.getByTestId('automatic-line-b1')).getByRole('link', { name: /Acme Logistics BV/ }));
    expect(panelOpen).toHaveBeenLastCalledWith({ type: 'bank_transaction', id: 'b1', stack: true });
  });

  it('undoes a line', async () => {
    const user = userEvent.setup();
    env.undo.mockImplementation((_id: string, options: { onSuccess: () => void }) => options.onSuccess());
    renderView();
    await user.click(within(screen.getByTestId('automatic-line-b4')).getByRole('button', { name: 'Undo' }));
    expect(env.undo).toHaveBeenCalledWith('b4', expect.anything());
    await waitFor(() => expect(env.toast.success).toHaveBeenCalledWith('Undone. The line is back in To process.'));
  });

  it('says why an undo failed', async () => {
    const user = userEvent.setup();
    env.undo.mockImplementation((_id: string, options: { onError: (error: Error) => void }) => options.onError(new Error('Period is locked')));
    renderView();
    await user.click(within(screen.getByTestId('automatic-line-b1')).getByRole('button', { name: 'Undo' }));
    expect(env.toast.error).toHaveBeenCalledWith('Could not undo that.', { description: 'Period is locked' });
  });

  it('offers no Undo without banking:update', () => {
    env.permissions = new Set();
    renderView();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('pages through the rest', async () => {
    const user = userEvent.setup();
    env.hasNextPage = true;
    renderView();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(env.fetchNextPage).toHaveBeenCalled();
  });

  it('says so when nothing was booked automatically, or the list cannot be loaded', () => {
    env.lines = [];
    const view = renderView();
    expect(screen.getByText('Nothing was booked automatically yet.')).toBeInTheDocument();
    view.unmount();
    env.isError = true;
    renderView();
    expect(screen.getByRole('alert')).toHaveTextContent('The automatic bookings could not be loaded.');
  });
});

describe('review marks (books-questions)', () => {
  const withEntry = (reason: BankLineLinks['reason'], entryId: string) => ({
    ...withReason(reason),
    journalEntry: { id: entryId, entryNumber: null, date: '2026-11-25', description: null, sourceType: null, sourceId: null },
  });

  beforeEach(() => {
    env.lines = [
      line('b1', 'Acme Logistics BV', '1210.00'),
      line('b2', 'Studio Noord BV', '-2500.00'),
      line('b3', 'Belastingdienst', '-640.00'),
      line('b4', 'Telnet Zakelijk', '-89.95'),
    ];
    env.isError = false;
    env.isLoading = false;
    env.hasNextPage = false;
    env.filters = [];
    env.toast.success.mockReset();
    env.toast.error.mockReset();
    env.permissions = new Set(['banking:update', 'journal:update']);
    env.links = {
      b1: withEntry('document_match', 'je_1'),
      b2: withEntry('own_account_transfer', 'je_2'),
      b3: withEntry('tax_authority', 'je_3'),
      b4: withEntry('rule', 'je_4'),
    };
  });

  it('asks for the lines that are not reviewed yet, and for the reviewed ones when the filter says so', async () => {
    const user = userEvent.setup();
    renderView();
    expect(env.filters.at(-1)).toEqual({ bankAccountId: 'ba_1', processedAutomatically: true, reviewed: false });
    expect(screen.getByTestId('review-filter-notReviewed')).toBeChecked();
    await user.click(screen.getByTestId('review-filter-reviewed'));
    expect(env.filters.at(-1)).toEqual({ bankAccountId: 'ba_1', processedAutomatically: true, reviewed: true });
  });

  it('shows each line as Not reviewed, or Reviewed with the date of the mark', () => {
    env.lines = [line('b1', 'Acme Logistics BV', '1210.00'), { ...line('b2', 'Studio Noord BV', '-2500.00'), reviewedAt: '2026-11-26T10:00:00Z' }];
    renderView();
    const chip = (id: string) => within(screen.getByTestId(`automatic-line-${id}`)).getByTestId('review-chip');
    expect(chip('b1')).toHaveTextContent('Not reviewed');
    expect(chip('b2')).toHaveTextContent('Reviewed');
  });

  it('marks one line reviewed through its booking', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(within(screen.getByTestId('automatic-line-b3')).getByTestId('review-mark'));
    expect(env.setReview).toHaveBeenCalledWith({ journalEntryId: 'je_3', reviewed: true }, expect.anything());
  });

  it('takes the mark off a reviewed line', async () => {
    const user = userEvent.setup();
    env.lines = [{ ...line('b1', 'Acme Logistics BV', '1210.00'), reviewedAt: '2026-11-26T10:00:00Z' }];
    renderView();
    await user.click(screen.getByTestId('review-filter-reviewed'));
    await user.click(within(screen.getByTestId('automatic-line-b1')).getByTestId('review-unmark'));
    expect(env.setReview).toHaveBeenCalledWith({ journalEntryId: 'je_1', reviewed: false }, expect.anything());
  });

  it('marks the lines picked as reviewed in one go, and says what was left as it was', async () => {
    const user = userEvent.setup();
    env.reviewLines.mockImplementation((_ids: string[], options: { onSuccess: (r: unknown) => void }) =>
      options.onSuccess({ reviewed: ['je_1'], skipped: ['je_2'], withoutEntry: 0 }),
    );
    renderView();
    expect(screen.getByTestId('review-bulk-mark')).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select Acme Logistics BV' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Studio Noord BV' }));
    expect(screen.getByText('2 lines selected')).toBeInTheDocument();
    await user.click(screen.getByTestId('review-bulk-mark'));
    expect(env.reviewLines).toHaveBeenCalledWith(['b1', 'b2'], expect.anything());
    expect(env.toast.success).toHaveBeenCalledWith('1 booking marked as reviewed. 1 was left as it was.');
    // The selection is cleared afterwards.
    expect(screen.getByRole('checkbox', { name: 'Select Acme Logistics BV' })).not.toBeChecked();
  });

  it('selects every line shown with one click', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(within(screen.getByTestId('review-bulk-bar')).getByRole('checkbox'));
    expect(screen.getByText('4 lines selected')).toBeInTheDocument();
  });

  it('says so when the marks could not be set', async () => {
    const user = userEvent.setup();
    env.reviewLines.mockImplementation((_ids: string[], options: { onError: (e: Error) => void }) => options.onError(new Error('Period is locked')));
    renderView();
    await user.click(screen.getByRole('checkbox', { name: 'Select Acme Logistics BV' }));
    await user.click(screen.getByTestId('review-bulk-mark'));
    expect(env.toast.error).toHaveBeenCalledWith('The bookings could not be marked as reviewed', { description: 'Period is locked' });
  });

  it('says everything is reviewed when nothing is left', () => {
    env.lines = [];
    renderView();
    expect(screen.getByText('Everything booked automatically has been reviewed.')).toBeInTheDocument();
  });

  it('is for accountants only: without journal:update the lines are as they were, with no review controls', () => {
    env.permissions = new Set(['banking:update']);
    renderView();
    expect(env.filters.at(-1)).toEqual({ bankAccountId: 'ba_1', processedAutomatically: true });
    expect(screen.queryByTestId('review-filter')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-chip')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('is not there on Global', () => {
    env.questions = false;
    renderView();
    expect(env.filters.at(-1)).toEqual({ bankAccountId: 'ba_1', processedAutomatically: true });
    expect(screen.queryByTestId('review-filter')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-mark')).not.toBeInTheDocument();
  });
});

describe('automaticReasonLabel', () => {
  const copy = {
    document_match: 'doc',
    own_account_transfer: 'own',
    tax_authority: 'tax',
    rule: 'Rule: {name}',
    other: 'other',
  };

  it('names the reason, and falls back to the generic one', () => {
    expect(automaticReasonLabel('rule', { id: 'r', name: 'X' }, copy)).toBe('Rule: X');
    expect(automaticReasonLabel('document_match', null, copy)).toBe('doc');
    expect(automaticReasonLabel(null, null, copy)).toBe('other');
    expect(automaticReasonLabel(undefined, null, copy)).toBe('other');
    expect(automaticReasonLabel('something_new' as never, null, copy)).toBe('other');
  });
});
