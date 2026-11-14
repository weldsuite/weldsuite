/**
 * Invoice links on the billing pages: a public (Stripe) link opens as a plain
 * anchor; a Mollie invoice, an API path behind the session, opens in a tab
 * opened inside the click and filled once the document is fetched.
 */

import type { MouseEvent } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const toast = vi.hoisted(() => ({ error: vi.fn() }));
const openInvoiceDocument = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({ getRaw: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => client }),
}));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      settings: {
        billing: {
          mollie: {
            invoicePopupBlocked: 'Allow pop-ups to open the invoice.',
            invoiceOpenFailed: 'The invoice could not be opened.',
            invoiceTitle: 'Invoice',
          },
        },
      },
    },
  }),
}));
vi.mock('@/lib/billing/invoice-document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/invoice-document')>()),
  openInvoiceDocument,
}));

import { useInvoiceLinkClick } from './use-invoice-document';

const click = () => ({ preventDefault: vi.fn() }) as unknown as MouseEvent<HTMLAnchorElement>;

describe('useInvoiceLinkClick', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves a public invoice link to the browser', () => {
    const open = vi.spyOn(window, 'open');
    const { result } = renderHook(() => useInvoiceLinkClick());
    const event = click();
    result.current(event, 'https://pay.stripe.com/invoice/acct_1/pdf');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a Mollie invoice in a new tab without an opener, then fills it', async () => {
    const tab = { opener: window, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(tab);
    openInvoiceDocument.mockResolvedValue(undefined);
    const { result } = renderHook(() => useInvoiceLinkClick());
    const event = click();
    result.current(event, '/api/billing/invoices/binv_1/document');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    await waitFor(() =>
      expect(openInvoiceDocument).toHaveBeenCalledWith(client, '/api/billing/invoices/binv_1/document', tab, 'Invoice'),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says so when the popup blocker stops the tab', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useInvoiceLinkClick());
    result.current(click(), '/api/billing/invoices/binv_1/document');
    expect(toast.error).toHaveBeenCalledWith('Allow pop-ups to open the invoice.');
    expect(openInvoiceDocument).not.toHaveBeenCalled();
  });

  it('closes the tab and says so when the document cannot be fetched', async () => {
    const tab = { opener: window, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(tab);
    openInvoiceDocument.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useInvoiceLinkClick());
    result.current(click(), '/api/billing/invoices/binv_1/document');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The invoice could not be opened.'));
    expect(tab.close).toHaveBeenCalled();
  });
});
