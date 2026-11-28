import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountingEntity } from '@/lib/api/domains/weldbooks';
import type { LockDateSuggestion } from '@/lib/api/domains/weldbooks-questions';

const env = vi.hoisted(() => ({
  questions: true,
  suggestion: undefined as unknown,
  enabledSeen: [] as unknown[],
  updateLockDates: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  push: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ type, id, label }: { type: string; id: string; label: string; secondary?: string }) => (
    <a href={`#${type}:${id}`} data-testid="record-link">
      {label}
    </a>
  ),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatDate: (value: string) => `date:${value}` }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useUpdateLockDates: () => ({ mutateAsync: env.updateLockDates, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldbooks-questions-queries', () => ({
  isQuestionsAvailable: () => env.questions,
  useLockDateSuggestion: (_id: string, options: { enabled?: boolean }) => {
    env.enabledSeen.push(options.enabled);
    return { data: options.enabled === false ? undefined : env.suggestion };
  },
}));

import { renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';
import { LockDateSuggestionBanner } from './lock-date-suggestion';
import { LockDatesCard } from './lock-dates-card';

const bankLine: LockDateSuggestion = {
  suggestedDate: '2026-09-30',
  reason: 'oldest_unprocessed_bank_line',
  blockingItem: { kind: 'bank_line', objectType: 'bank_transaction', objectId: 'btx_1', date: '2026-10-01' },
};

beforeEach(() => {
  env.questions = true;
  env.suggestion = bankLine;
  env.enabledSeen = [];
  env.updateLockDates.mockReset();
  env.toast.success.mockReset();
  env.toast.info.mockReset();
  env.push.mockReset();
});

describe('the suggested lock date', () => {
  it('says what can be locked, why, and which item blocks a later date', () => {
    renderWithProviders(<LockDateSuggestionBanner entityId="ent_1" onUse={vi.fn()} />);
    const banner = screen.getByTestId('lock-suggestion');
    expect(within(banner).getByRole('heading')).toHaveTextContent('You can lock up to date:2026-09-30');
    expect(banner).toHaveTextContent('The oldest bank line still to process is dated date:2026-10-01.');
    expect(within(banner).getByText('Blocked by')).toBeInTheDocument();
    expect(within(banner).getByTestId('record-link')).toHaveAttribute('href', '#bank_transaction:btx_1');
  });

  it.each([
    ['oldest_unbooked_document', 'document', 'accounting_document', 'The oldest document in the inbox that is not booked arrived on date:2026-10-01.'],
    ['oldest_draft_invoice', 'draft_invoice', 'invoice', 'The oldest draft invoice is dated date:2026-10-01.'],
    ['oldest_draft_bill', 'draft_bill', 'bill', 'The oldest draft bill is dated date:2026-10-01.'],
  ] as const)('explains %s', (reason, kind, objectType, sentence) => {
    env.suggestion = { suggestedDate: '2026-09-30', reason, blockingItem: { kind, objectType, objectId: 'x_1', date: '2026-10-01' } };
    renderWithProviders(<LockDateSuggestionBanner entityId="ent_1" onUse={vi.fn()} />);
    expect(screen.getByTestId('lock-suggestion')).toHaveTextContent(sentence);
  });

  it('opens a blocking inbox document on the documents page', () => {
    env.suggestion = {
      suggestedDate: '2026-09-30',
      reason: 'oldest_unbooked_document',
      blockingItem: { kind: 'document', objectType: 'accounting_document', objectId: 'doc 1', date: '2026-10-01' },
    };
    renderWithProviders(<LockDateSuggestionBanner entityId="ent_1" onUse={vi.fn()} />);
    expect(within(screen.getByTestId('lock-suggestion')).getByRole('link', { name: /Document/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/weldbooks/documents?document=doc%201'),
    );
  });

  it('has no blocking item when nothing is left to process', () => {
    env.suggestion = { suggestedDate: '2026-10-31', reason: 'end_of_last_month' };
    renderWithProviders(<LockDateSuggestionBanner entityId="ent_1" onUse={vi.fn()} />);
    expect(screen.getByTestId('lock-suggestion')).toHaveTextContent('Nothing is left to process, so this is the end of last month.');
    expect(screen.queryByText('Blocked by')).not.toBeInTheDocument();
  });

  it('hands the date over with "Use this date"', async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    renderWithProviders(<LockDateSuggestionBanner entityId="ent_1" onUse={onUse} />);
    await user.click(screen.getByRole('button', { name: 'Use this date' }));
    expect(onUse).toHaveBeenCalledWith('2026-09-30');
  });

  it('shows nothing before there is a suggestion, on Global, or when the member may not set locks', () => {
    env.suggestion = undefined;
    const waiting = renderWithProviders(<LockDateSuggestionBanner entityId="ent_1" onUse={vi.fn()} />);
    expect(waiting.container).toBeEmptyDOMElement();
    waiting.unmount();
    env.suggestion = bankLine;
    env.questions = false;
    const global = renderWithProviders(<LockDateSuggestionBanner entityId="ent_1" onUse={vi.fn()} />);
    expect(global.container).toBeEmptyDOMElement();
    global.unmount();
    env.questions = true;
    const readOnly = renderWithProviders(<LockDateSuggestionBanner entityId="ent_1" onUse={vi.fn()} disabled />);
    expect(readOnly.container).toBeEmptyDOMElement();
    expect(env.enabledSeen.at(-1)).toBe(false);
  });
});

describe('in the lock dates form', () => {
  const entity = { id: 'ent_1', name: 'Atelier BV', periodLockDate: '2026-06-30', hardLockDate: null } as unknown as AccountingEntity;
  const periodInput = () => screen.getByLabelText('Period lock date') as HTMLInputElement;

  it('fills the period lock with the suggested date and saves nothing until the member saves', async () => {
    const user = userEvent.setup();
    env.updateLockDates.mockResolvedValue({});
    renderWithProviders(<LockDatesCard entity={entity} canUpdate />);
    expect(periodInput().value).toBe('2026-06-30');
    await user.click(screen.getByRole('button', { name: 'Use this date' }));
    expect(periodInput().value).toBe('2026-09-30');
    expect(env.toast.info).toHaveBeenCalledWith('Date filled in. Save to lock.');
    expect(env.updateLockDates).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save lock dates' }));
    await waitFor(() => expect(env.updateLockDates).toHaveBeenCalledWith({ id: 'ent_1', data: { periodLockDate: '2026-09-30' } }));
  });

  it('shows no suggestion to a member who may not change the dates', () => {
    renderWithProviders(<LockDatesCard entity={entity} canUpdate={false} />);
    expect(screen.queryByTestId('lock-suggestion')).not.toBeInTheDocument();
  });

  it('shows no suggestion on Global', () => {
    env.questions = false;
    renderWithProviders(<LockDatesCard entity={entity} canUpdate />);
    expect(screen.queryByTestId('lock-suggestion')).not.toBeInTheDocument();
  });
});
