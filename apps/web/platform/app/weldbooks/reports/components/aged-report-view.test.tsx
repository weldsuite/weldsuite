import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AGING_BUCKETS, type AgedReport } from '@/lib/weldbooks/report-types';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={params ? to.replace('$id', params.id) : to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({ labels: { supplier: 'Vendor' } }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => String(value ?? ''),
  }),
}));

import { AgedReportView } from './aged-report-view';

const documents: AgedReport['documents'] = [
  {
    id: 'doc_1',
    number: 'INV-1',
    contactId: 'con_1',
    contactName: 'Globex',
    issueDate: '2026-08-01',
    dueDate: '2026-09-01',
    daysPastDue: 37,
    bucket: '31-60',
    balance: '100.00',
  },
  {
    id: 'doc_2',
    number: 'INV-2',
    contactId: 'con_1',
    contactName: 'Globex',
    issueDate: '2026-10-01',
    dueDate: '2026-11-01',
    daysPastDue: -24,
    bucket: 'current',
    balance: '50.00',
  },
];

const contacts: AgedReport['contacts'] = [
  { contactId: 'con_1', contactName: 'Globex', total: '150.00', current: '50.00', '1-30': '0.00', '31-60': '100.00', '61-90': '0.00', '90+': '0.00' },
];

/** The summary card of a bucket (the label also heads a table column). */
function bucketCard(label: string): HTMLElement {
  const title = screen.getAllByText(label).find((el) => el.closest('[data-slot="card"]'));
  if (!title) throw new Error('No card for ' + label);
  return title.closest('[data-slot="card"]') as HTMLElement;
}

describe('AgedReportView', () => {
  it('reads the buckets of aged receivables, answered as total and count', () => {
    const report: AgedReport = {
      asOf: '2026-10-08',
      buckets: {
        current: { total: '50.00', count: 1 },
        '1-30': { total: '0.00', count: 0 },
        '31-60': { total: '100.00', count: 1 },
        '61-90': { total: '0.00', count: 0 },
        '90+': { total: '0.00', count: 0 },
      },
      total: '150.00',
      contacts,
      documents,
    };
    render(<AgedReportView report={report} kind="receivables" />);

    const current = bucketCard('Current');
    expect(within(current).getByText('$50.00')).toBeInTheDocument();
    expect(within(current).getByText('1 documents')).toBeInTheDocument();
    const middle = bucketCard('31-60 days');
    expect(within(middle).getByText('$100.00')).toBeInTheDocument();
  });

  it('reads the buckets of aged payables, answered as plain strings with the counts beside them', () => {
    const report: AgedReport = {
      asOf: '2026-10-08',
      buckets: { current: '50.00', '1-30': '0.00', '31-60': '100.00', '61-90': '0.00', '90+': '0.00' },
      bucketCounts: { current: 1, '1-30': 0, '31-60': 1, '61-90': 0, '90+': 0 },
      total: '150.00',
      contacts,
      documents,
    };
    render(<AgedReportView report={report} kind="payables" />);

    const middle = bucketCard('31-60 days');
    expect(within(middle).getByText('$100.00')).toBeInTheDocument();
    expect(within(middle).getByText('1 documents')).toBeInTheDocument();
    // Payables name the counterparty with the jurisdiction's word and link to bills.
    expect(screen.getAllByText('Vendor').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'INV-1' })).toHaveAttribute('href', '/weldbooks/bills/doc_1');
  });

  it('lists the buckets per contact with a total row, and the documents with their days past due', () => {
    const report: AgedReport = {
      asOf: '2026-10-08',
      buckets: { current: '50.00', '1-30': '0.00', '31-60': '100.00', '61-90': '0.00', '90+': '0.00' },
      bucketCounts: { current: 1, '1-30': 0, '31-60': 1, '61-90': 0, '90+': 0 },
      total: '150.00',
      contacts,
      documents,
    };
    render(<AgedReportView report={report} kind="receivables" />);

    const byContact = screen.getByRole('table', { name: 'By Contact' });
    const globex = within(byContact).getByRole('row', { name: /Globex/ });
    expect(within(globex).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Globex', '$50.00', '-', '$100.00', '-', '-', '$150.00']);
    const total = within(byContact).getAllByRole('row').at(-1)!;
    expect(within(total).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Total', '$50.00', '$0.00', '$100.00', '$0.00', '$0.00', '$150.00']);

    const docs = screen.getByRole('table', { name: 'Open documents' });
    const overdue = within(docs).getByRole('row', { name: /INV-1/ });
    expect(within(overdue).getByRole('link', { name: 'INV-1' })).toHaveAttribute('href', '/weldbooks/invoices/doc_1');
    expect(within(overdue).getAllByRole('cell').map((c) => c.textContent)).toContain('37');
    // Not due yet is not "overdue by -24 days".
    const notDue = within(docs).getByRole('row', { name: /INV-2/ });
    expect(within(notDue).getAllByRole('cell').map((c) => c.textContent)).toContain('0');
  });

  it('says so when nothing is outstanding', () => {
    const empty: AgedReport = {
      asOf: '2026-10-08',
      buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b, '0.00'])) as AgedReport['buckets'],
      total: '0.00',
      contacts: [],
      documents: [],
    };
    const { unmount } = render(<AgedReportView report={empty} kind="receivables" />);
    expect(screen.getByText('No outstanding receivables')).toBeInTheDocument();
    unmount();
    render(<AgedReportView report={empty} kind="payables" />);
    expect(screen.getByText('No outstanding payables')).toBeInTheDocument();
  });
});
