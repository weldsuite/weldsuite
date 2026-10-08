import { useMemo } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Link } from '@/lib/router';
import type { TaxPreviewState } from '@/hooks/queries/use-weldbooks-tax-preview';
import { groupTaxBreakdown } from '@/lib/weldbooks/document-tax';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { TaxBreakdownList, TaxWarnings } from './tax-breakdown';

/** The tax can't be calculated without a ship-to (or bill-to) state and ZIP code. */
export function AddressNeededNotice() {
  const td = useDocumentTexts();
  return (
    <InfoBanner variant="warning" title={td.panel.addressNeededTitle}>
      <span data-testid="address-needed">{td.panel.addressNeeded}</span>
    </InfoBanner>
  );
}

interface DocumentTaxPanelProps {
  state: TaxPreviewState;
  /** The entity charges sales tax: the breakdown, address notice and warnings are shown. */
  salesTax: boolean;
  currency?: string | null;
  /** Label of the tax ("Sales tax", "VAT"). */
  taxLabel: string;
  /** Bills have no ship-to, so they have no address notice. */
  kind?: 'invoice' | 'bill';
  /** Show the "add a ship-to address" notice (a form that shows it next to its address fields turns it off). */
  showAddressNotice?: boolean;
  className?: string;
}

/**
 * What the tax calculation says about a draft, under the form's totals: a
 * subtle "calculating" state, the per-jurisdiction breakdown, the engine's
 * warnings in words, a notice when the ship-to address is incomplete and an
 * inline error when the engine is unavailable. The last good values stay
 * visible when a calculation fails.
 */
export function DocumentTaxPanel({
  state,
  salesTax,
  currency,
  taxLabel,
  kind = 'invoice',
  showAddressNotice = true,
  className,
}: Readonly<DocumentTaxPanelProps>) {
  const td = useDocumentTexts();
  const { result, isCalculating, error, errorCode } = state;

  const groups = useMemo(() => groupTaxBreakdown(result?.taxBreakdown), [result?.taxBreakdown]);

  return (
    <div className={className ?? 'space-y-3'} data-testid="document-tax-panel">
      {isCalculating && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {td.panel.calculating}
        </p>
      )}

      {error && errorCode === 'TAX_ENGINE_UNAVAILABLE' && (
        <Alert variant="destructive" data-testid="engine-unavailable">
          <AlertTriangle />
          <AlertDescription>
            <p className="font-medium text-destructive">{td.panel.engineUnavailableTitle}</p>
            <p>{td.panel.engineUnavailable}</p>
            <Link
              href="/weldbooks/sales-tax/settings"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {td.panel.openSettings}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {error && errorCode !== 'TAX_ENGINE_UNAVAILABLE' && (
        <p className="text-xs text-destructive" role="alert">
          {error.message || td.panel.previewFailed}
          {result ? ` ${td.panel.lastCalculation}` : ''}
        </p>
      )}

      {salesTax && result?.addressIncomplete && kind === 'invoice' && showAddressNotice && <AddressNeededNotice />}

      {salesTax && groups.length > 0 && <TaxBreakdownList groups={groups} currency={currency} taxLabel={taxLabel} />}

      {salesTax && result && groups.length === 0 && !result.addressIncomplete && Number(result.subtotal) > 0 && (
        <p className="text-xs text-muted-foreground">{td.panel.noTaxCharged}</p>
      )}

      {salesTax && <TaxWarnings warnings={result?.warnings} state={result?.shipToState} />}

      {salesTax && result && <p className="text-xs text-muted-foreground">{td.panel.estimateNote}</p>}
    </div>
  );
}
