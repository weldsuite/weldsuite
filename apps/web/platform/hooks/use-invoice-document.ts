import { useCallback, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { isApiInvoiceUrl, openInvoiceDocument } from '@/lib/billing/invoice-document';

/**
 * Click handler for an invoice link. A public link (Stripe) opens as a plain
 * anchor; an authenticated API path (Mollie) is fetched with the session and
 * shown in a new tab, since a link can't send the bearer token.
 */
export function useInvoiceLinkClick() {
  const { getClient } = useAppApiClient();
  const { t } = useI18n();
  const strings = t.settings.billing.mollie;

  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>, pdfUrl: string) => {
      if (!isApiInvoiceUrl(pdfUrl)) return;
      event.preventDefault();
      // Opened now, inside the click, before anything is awaited (a token
      // refresh would take it out of the click and the popup blocker would
      // stop it). The app never navigates away to the document.
      const tab = window.open('', '_blank');
      if (!tab) {
        toast.error(strings.invoicePopupBlocked);
        return;
      }
      tab.opener = null;
      void (async () => {
        try {
          await openInvoiceDocument(await getClient(), pdfUrl, tab, strings.invoiceTitle);
        } catch {
          tab.close();
          toast.error(strings.invoiceOpenFailed);
        }
      })();
    },
    [getClient, strings],
  );
}
