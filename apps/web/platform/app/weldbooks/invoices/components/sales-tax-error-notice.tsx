import { AlertTriangle } from 'lucide-react';
import { Link as TanStackLink } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Link } from '@/lib/router';
import { salesTaxErrorCode, type SalesTaxErrorCode } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';

type ErrorTexts = ReturnType<typeof useErrorTexts>;

function useErrorTexts() {
  return useDocumentTexts().errors;
}

/** True when the tax engine is down but the request itself was fine, so trying again can work. */
export function isRetryableTaxError(err: unknown): boolean {
  if (salesTaxErrorCode(err) !== 'TAX_ENGINE_UNAVAILABLE') return false;
  const status = (err as { status?: unknown }).status;
  const body = (err as { body?: { error?: { details?: { retryable?: unknown } } } }).body;
  return body?.error?.details?.retryable === true || status === 503;
}

/** The message of a sales tax refusal in the user's words; null for any other error. */
export function describeSalesTaxError(err: unknown, texts: ErrorTexts): string | null {
  switch (salesTaxErrorCode(err)) {
    case 'ADDRESS_REQUIRED':
      return texts.addressRequired;
    case 'TAX_ENGINE_UNAVAILABLE':
      return isRetryableTaxError(err) ? texts.engineUnavailableRetry : texts.engineUnavailable;
    case 'TAX_RATES_NOT_CONFIGURED':
      return texts.ratesNotConfigured;
    case 'USE_TAX_ENGINE_UNSUPPORTED':
      return texts.useTaxUnsupported;
    case 'TAX_NOT_CALCULATED':
      return texts.notCalculated;
    case 'CREDIT_LINE_NOT_ON_ORIGINAL':
      return texts.creditLineNotOnOriginal;
    case 'TAX_COMMIT_NOT_APPLICABLE':
      return texts.commitNotApplicable;
    case null:
      return null;
  }
}

/** Hook form of {@link describeSalesTaxError}: the message of a sales tax refusal, or the error's own message. */
export function useDescribeError() {
  const texts = useErrorTexts();
  return (err: unknown): string | undefined =>
    describeSalesTaxError(err, texts) ?? (err instanceof Error ? err.message : undefined);
}

interface SalesTaxErrorNoticeProps {
  /** The failed request's error (a finalize, a send, a save). */
  error: unknown;
  /** The invoice: the address link opens its edit page. */
  invoiceId?: string;
  className?: string;
}

/**
 * A sales tax refusal of finalize / send / save as a notice that says what to
 * do and links to where: the invoice's addresses, the sales tax settings or
 * the agencies. Renders nothing for an error that is not a sales tax one.
 */
export function SalesTaxErrorNotice({ error, invoiceId, className }: Readonly<SalesTaxErrorNoticeProps>) {
  const texts = useErrorTexts();
  const code: SalesTaxErrorCode | null = salesTaxErrorCode(error);
  const message = describeSalesTaxError(error, texts);
  if (!code || !message) return null;

  const linkClass = 'text-sm font-medium text-primary underline-offset-4 hover:underline';
  return (
    <Alert variant="destructive" className={className} data-testid="sales-tax-error">
      <AlertTriangle />
      <AlertDescription>
        <p className="text-destructive">{message}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {code === 'ADDRESS_REQUIRED' && invoiceId && (
            <TanStackLink to="/weldbooks/invoices/$id/edit" params={{ id: invoiceId }} className={linkClass}>
              {texts.editAddress}
            </TanStackLink>
          )}
          {(code === 'TAX_ENGINE_UNAVAILABLE' || code === 'USE_TAX_ENGINE_UNSUPPORTED') && (
            <Link href="/weldbooks/sales-tax/settings" className={linkClass}>
              {texts.openSettings}
            </Link>
          )}
          {(code === 'TAX_RATES_NOT_CONFIGURED' || code === 'USE_TAX_ENGINE_UNSUPPORTED') && (
            <Link href="/weldbooks/sales-tax/agencies" className={linkClass}>
              {texts.openAgencies}
            </Link>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
