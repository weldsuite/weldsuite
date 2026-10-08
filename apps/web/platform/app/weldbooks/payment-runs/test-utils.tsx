/**
 * Render helpers of the payment run tests. Not a test file itself: each test
 * file mocks the transport (`weldbooksApi`), permissions, the router, the
 * WeldBooks formatter and toasts, then renders through here.
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { CheckPrintData, CheckPrintItem, CheckLayoutId } from '@/lib/api/domains/weldbooks-payment-runs';
import { getCheckLayout } from '@/lib/weldbooks/check-layout';

/** Radix selects and menus call these; jsdom has none of them. */
export function installPointerPolyfills(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
}

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export function renderWithProviders(ui: ReactElement, client: QueryClient = newQueryClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage="en">{ui}</I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

/** The money and date formatting of the tests: plain and predictable. */
export const testFormat = {
  formatMoney: (value: string | number | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
  formatDate: (value: string | Date | null | undefined) => `date:${String(value ?? '').slice(0, 10)}`,
  formatDateTime: (value: string | Date | null | undefined) => `at:${String(value ?? '')}`,
  today: () => '2026-10-08',
};

export function makeCheck(number: string, payee: string, amount: string, overrides: Partial<CheckPrintItem> = {}): CheckPrintItem {
  return {
    paymentId: `pay_${number}`,
    checkNumber: number,
    checkStatus: 'to_print',
    date: '2026-10-09',
    dateDisplay: '10/09/2026',
    amount,
    grossAmount: amount,
    backupWithholdingAmount: null,
    amountInWords: 'One hundred and 00/100',
    courtesyAmount: `$**${amount}`,
    payee: { partyId: `par_${number}`, name: payee, addressLines: ['1 Main St', 'Austin, TX 78701'] },
    memo: 'Bill INV-1',
    fractionalRouting: '90-7162/0210',
    micr: null,
    voucher: {
      rows: [
        { date: '2026-09-01', reference: 'INV-1', description: null, amount, billTotal: amount, discount: null },
      ],
      grossTotal: amount,
      backupWithholding: null,
      total: amount,
    },
    ...overrides,
  };
}

export function makePrintData(
  checks: CheckPrintItem[],
  options: { layout?: CheckLayoutId; printMicr?: boolean } = {},
): CheckPrintData {
  const layoutId = options.layout ?? 'voucher_top';
  return {
    run: { id: 'prn_1', status: 'approved', paymentDate: '2026-10-09', bankAccountId: 'bnk_1' },
    layout: getCheckLayout(layoutId),
    settings: {
      layout: layoutId,
      printMicr: options.printMicr ?? false,
      signatureLineText: 'Authorized signature',
      checkNumberWidth: 6,
    },
    payer: { name: 'Acme Holdings LLC', dba: 'Acme', addressLines: ['10 Market St', 'Dallas, TX 75201'] },
    bank: { name: 'First Bank', addressLines: ['1 Bank Plaza'], accountNumberLast4: '1234' },
    checks,
  };
}
