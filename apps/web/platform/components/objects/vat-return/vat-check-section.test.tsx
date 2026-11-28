import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { VAT_CHECK_KEYS, type VatCheck, type VatChecks } from '@/lib/api/domains/weldbooks-questions';

const env = vi.hoisted(() => ({
  questions: true,
  allowed: new Set<string>(['reports:read']),
  checks: undefined as unknown,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
  push: vi.fn(),
  enabledSeen: [] as unknown[],
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: env.push }),
}));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ type, id, label }: { type: string; id: string; label: string }) => (
    <a href={`#${type}:${id}`} data-testid="record-link">
      {label}
    </a>
  ),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: string, currency?: string) => `${currency ?? ''} ${value}`.trim() }),
}));
vi.mock('@/hooks/queries/use-weldbooks-questions-queries', () => ({
  isQuestionsAvailable: () => env.questions,
  useVatReturnChecks: (_id: string, options: { enabled?: boolean }) => {
    env.enabledSeen.push(options.enabled);
    return {
      data: env.checks,
      isError: env.isError,
      isFetching: env.isFetching,
      refetch: env.refetch,
    };
  },
}));

import { renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';
import { VatCheckSection } from './vat-check-section';

const none: VatCheck = { count: 0, sampleIds: [] };

function checks(overrides: Partial<VatChecks> = {}): VatChecks {
  return Object.fromEntries(VAT_CHECK_KEYS.map((key) => [key, overrides[key] ?? none])) as VatChecks;
}

beforeEach(() => {
  env.questions = true;
  env.allowed = new Set(['reports:read']);
  env.checks = checks();
  env.isError = false;
  env.isFetching = false;
  env.enabledSeen = [];
  env.refetch.mockReset();
  env.push.mockReset();
});

const renderSection = (filed = false) => renderWithProviders(<VatCheckSection vatReturnId="vat_1" filed={filed} />);

describe('the VAT return check', () => {
  it('lists every check with its count, its amount and sample chips, and links to where it is dealt with', () => {
    env.checks = checks({
      unprocessed_bank_lines: { count: 12, sampleIds: ['b1', 'b2', 'b3'], amount: '3400.50', currency: 'EUR' },
      unbooked_documents: { count: 2, sampleIds: ['d1', 'd2'] },
      draft_invoices_in_period: { count: 1, sampleIds: ['i1'], amount: '121.00', currency: 'EUR' },
    });
    renderSection();
    const section = screen.getByTestId('vat-check');
    expect(within(section).getByRole('heading', { name: 'Check before you file' })).toBeInTheDocument();
    expect(within(section).getAllByRole('listitem').filter((li) => li.dataset.testid?.startsWith('vat-check-'))).toHaveLength(6);

    const lines = screen.getByTestId('vat-check-unprocessed_bank_lines');
    expect(lines).toHaveTextContent('Bank lines still to process');
    expect(within(lines).getByTestId('vat-check-unprocessed_bank_lines-count')).toHaveTextContent('12');
    expect(lines).toHaveTextContent('EUR 3400.50');
    const chips = within(lines).getAllByTestId('record-link');
    expect(chips.map((chip) => chip.getAttribute('href'))).toEqual(['#bank_transaction:b1', '#bank_transaction:b2', '#bank_transaction:b3']);
    expect(within(lines).getByRole('link', { name: 'Process the lines' })).toHaveAttribute('href', '/weldbooks/banking/process');

    // A chip of an inbox document opens its dialog (it has no panel); a draft invoice stacks its panel.
    const documents = screen.getByTestId('vat-check-unbooked_documents');
    expect(within(documents).getAllByRole('link', { name: /Document \d/ })[0]).toHaveAttribute(
      'href',
      expect.stringContaining('/weldbooks/documents?document=d1'),
    );
    expect(within(documents).getByRole('link', { name: 'Open the inbox' })).toHaveAttribute('href', '/weldbooks/documents');
    expect(within(screen.getByTestId('vat-check-draft_invoices_in_period')).getByTestId('record-link')).toHaveAttribute(
      'href',
      '#invoice:i1',
    );
    expect(within(screen.getByTestId('vat-check-draft_invoices_in_period')).getByRole('link', { name: 'Open the drafts' })).toHaveAttribute(
      'href',
      '/weldbooks/invoices?status=draft',
    );
  });

  it('says "You can\'t see these." for a check the member may not read, with no count or links', () => {
    env.checks = checks({
      missing_receipts: { count: 0, sampleIds: [], restricted: true },
      unprocessed_bank_lines: { count: 3, sampleIds: ['b1'] },
    });
    renderSection();
    const restricted = screen.getByTestId('vat-check-missing_receipts');
    expect(within(restricted).getByTestId('vat-check-missing_receipts-restricted')).toHaveTextContent('You can’t see these.');
    expect(within(restricted).queryByTestId('vat-check-missing_receipts-count')).not.toBeInTheDocument();
    expect(within(restricted).queryByRole('link')).not.toBeInTheDocument();
    // The other checks are shown as usual, and a restricted one is not "all clear".
    expect(screen.getByTestId('vat-check-unprocessed_bank_lines-count')).toHaveTextContent('3');
    expect(screen.queryByTestId('vat-check-clear')).not.toBeInTheDocument();
  });

  it('does not call a restricted check "all clear" either when it is the only thing', () => {
    env.checks = checks({ open_transfers: { count: 0, sampleIds: [], restricted: true } });
    renderSection();
    expect(screen.queryByTestId('vat-check-clear')).not.toBeInTheDocument();
  });

  it('says nothing is open when every check is empty', () => {
    renderSection();
    expect(screen.getByTestId('vat-check-clear')).toHaveTextContent('Nothing is open in this period.');
  });

  it('says what a mixed-currency amount is shown in', () => {
    env.checks = checks({ missing_receipts: { count: 4, sampleIds: ['b1'], amount: '90.00', currency: 'EUR', mixedCurrency: true } });
    renderSection();
    expect(screen.getByText('Mixed currencies, shown in EUR')).toBeInTheDocument();
  });

  it('only warns: it shows no filing action and blocks nothing', () => {
    env.checks = checks({ unprocessed_bank_lines: { count: 5, sampleIds: ['b1'] } });
    renderSection();
    expect(screen.getByText(/you can still file/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /file|submit|mark/i })).not.toBeInTheDocument();
  });

  it('checks again on request', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('says the period is shown as it is now once the return is filed', () => {
    renderSection(true);
    expect(screen.getByText(/This return is filed/)).toBeInTheDocument();
  });

  it('says so when the check could not be loaded', async () => {
    const user = userEvent.setup();
    env.checks = undefined;
    env.isError = true;
    renderSection();
    expect(screen.getByText('The check could not be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('is not there on Global, and does not ask for the check', () => {
    env.questions = false;
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
    expect(env.enabledSeen.every((enabled) => enabled === false)).toBe(true);
  });

  it('is not there for a member who may not read reports', () => {
    env.allowed = new Set();
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
    expect(env.enabledSeen.every((enabled) => enabled === false)).toBe(true);
  });
});
