import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GstWorksheet } from '@/lib/api/domains/weldbooks-gst';

const env = vi.hoisted(() => ({
  worksheet: { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    refetch: () => void;
  },
  periods: [] as Array<{ periodStart: string; periodEnd: string }>,
}));

vi.mock('@/hooks/queries/use-weldbooks-gst-queries', () => ({
  useGstWorksheet: (period: { periodStart: string; periodEnd: string }) => {
    env.periods.push(period);
    return env.worksheet;
  },
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `₹${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    formatNumber: (value: number | string) => String(value),
    today: () => '2026-10-12',
    entity: { taxIdentifiers: { vatNumber: '27AABCU9603R1ZN' } },
  }),
}));

import GstReturnPage from './gst-return-page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const heads = (igst = 0, cgst = 0, sgst = 0) => ({ igst, cgst, sgst, cess: 0 });
const outward = (taxableValue: number, h = heads()) => ({ taxableValue, ...h });

const sheet: GstWorksheet = {
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  entityStateCode: '27',
  gstr1: {
    b2b: [
      {
        gstin: '27AAPFU0939F1ZV',
        name: 'Mumbai Traders',
        taxable: 10000,
        igst: 0,
        cgst: 900,
        sgst: 900,
        lines: [
          { documentId: 'inv_1', number: 'INV-0001', date: '2026-10-05', value: 11800, placeOfSupply: '27', slabRate: 18, taxable: 10000, igst: 0, cgst: 900, sgst: 900 },
        ],
      },
      {
        gstin: '29AABCU9603R1ZJ',
        name: 'Bengaluru Tech',
        taxable: 5000,
        igst: 900,
        cgst: 0,
        sgst: 0,
        lines: [
          { documentId: 'inv_2', number: 'INV-0002', date: '2026-10-06', value: 5900, placeOfSupply: '29', slabRate: 18, taxable: 5000, igst: 900, cgst: 0, sgst: 0 },
        ],
      },
    ],
    b2cLarge: [],
    b2cSmall: [{ placeOfSupply: '27', slabRate: 18, taxable: 1000, igst: 0, cgst: 90, sgst: 90 }],
    exports: [],
    nilExempt: [{ category: 'exempt', intraRegistered: 0, intraUnregistered: 500, interRegistered: 0, interUnregistered: 0 }],
    creditNotes: [],
    hsn: [{ hsnSac: '998313', unit: null, slabRate: 18, quantity: 3, taxable: 15000, igst: 900, cgst: 900, sgst: 900 }],
    totals: outward(16500, heads(900, 990, 990)),
  },
  gstr3b: {
    outwardTaxable: outward(16000, heads(900, 990, 990)),
    zeroRated: outward(0),
    nilExempt: { taxableValue: 500 },
    reverseCharge: outward(0),
    interStateUnregistered: [],
    itc: { other: heads(720, 180, 180), reverseCharge: heads(), total: heads(720, 180, 180) },
    payment: {
      liability: heads(900, 990, 990),
      reverseChargeLiability: heads(),
      itcUtilisation: { cash: heads(180, 810, 810), carryForward: heads(), creditUsed: heads(720, 180, 180) },
      netPayable: heads(180, 810, 810),
      totalNetPayable: 1800,
    },
  },
  unsplitTax: 0,
  warnings: [],
};

describe('GstReturnPage', { timeout: 30_000 }, () => {
  beforeEach(() => {
    env.periods = [];
    env.worksheet = { data: sheet, isLoading: false, isError: false, error: null, refetch: vi.fn() };
  });

  it('starts on the current month and shows the entity GSTIN', () => {
    renderWithProviders(<GstReturnPage />);

    expect(screen.getByRole('heading', { name: 'GST return' })).toBeInTheDocument();
    expect(screen.getByText('27AABCU9603R1ZN')).toBeInTheDocument();
    expect(env.periods.at(-1)).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    expect(screen.getByText(/Nothing is submitted from WeldBooks/)).toBeInTheDocument();
  });

  it('shows the GSTR-3B payment per head, ITC and net payable in cash', () => {
    renderWithProviders(<GstReturnPage />);

    expect(screen.getByText('Net payable in cash')).toBeInTheDocument();
    expect(screen.getByTestId('gst-total-net-payable')).toHaveTextContent('₹1800.00');
    expect(screen.getByText('Total ITC available')).toBeInTheDocument();
  });

  it('lists the GSTR-1 B2B supplies by GSTIN with the CGST/SGST or IGST of each invoice', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GstReturnPage />);

    await user.click(screen.getByRole('tab', { name: 'GSTR-1 outward supplies' }));

    expect(screen.getByText('27AAPFU0939F1ZV')).toBeInTheDocument();
    expect(screen.getByText('29AABCU9603R1ZJ')).toBeInTheDocument();
    const row = screen.getByText('INV-0002').closest('tr')!;
    expect(within(row).getByText('Karnataka (29)')).toBeInTheDocument();
    expect(within(row).getAllByText('₹900.00').length).toBeGreaterThan(0);
  });

  it('shows the HSN/SAC summary', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GstReturnPage />);

    await user.click(screen.getByRole('tab', { name: 'HSN/SAC summary' }));
    expect(screen.getByText('998313')).toBeInTheDocument();
  });

  it('puts the warnings of the worksheet above its tables', () => {
    env.worksheet = {
      ...env.worksheet,
      data: {
        ...sheet,
        unsplitTax: 180,
        warnings: [
          { code: 'unsplit_tax', count: 1, amount: 180 },
          { code: 'missing_hsn', count: 2 },
        ],
      },
    };
    renderWithProviders(<GstReturnPage />);

    const warnings = screen.getByTestId('gst-warnings');
    expect(warnings).toHaveTextContent('GST of ₹180.00 was booked at a slab rate without a CGST/SGST/IGST split');
    expect(warnings).toHaveTextContent('2 invoice lines have no HSN/SAC code');
  });

  it('moves to last month and to the quarter with the presets', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GstReturnPage />);

    await user.click(screen.getByRole('button', { name: 'Last month' }));
    expect(env.periods.at(-1)).toEqual({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    await user.click(screen.getByRole('button', { name: 'This quarter' }));
    expect(env.periods.at(-1)).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-12-31' });
  });

  it('says so when the worksheet cannot be calculated, and offers a retry', async () => {
    const user = userEvent.setup();
    env.worksheet = { data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch: vi.fn() };
    renderWithProviders(<GstReturnPage />);

    expect(screen.getByTestId('gst-load-error')).toHaveTextContent('boom');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(env.worksheet.refetch).toHaveBeenCalled();
  });
});
