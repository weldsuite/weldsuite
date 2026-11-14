import { useCallback, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { isApiInvoiceUrl, openInvoiceDocument } from '@/lib/billing/invoice-document';

/**
 * Click handler for an invoice link. A public link (Stripe) opens as a plain
 * anchor; an authenticated API path (Mollie) is fetched with the session and
 * opened as a blob, since a link can't send the bearer token.
 */
export function useInvoiceLinkClick() {
  const { getClient } = useAppApiClient();
  const { t } = useI18n();
  const failed = t.settings.billing.mollie.invoiceOpenFailed;

  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>, pdfUrl: string) => {
      if (!isApiInvoiceUrl(pdfUrl)) return;
      event.preventDefault();
      void (async () => {
        try {
          await openInvoiceDocument(await getClient(), pdfUrl);
        } catch {
          toast.error(failed);
        }
      })();
    },
    [getClient, failed],
  );
}
