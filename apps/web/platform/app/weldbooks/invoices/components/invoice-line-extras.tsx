import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@weldsuite/ui/components/collapsible';
import type { TaxUse } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { hasCompleteOverride } from '@/lib/weldbooks/document-tax';
import type { SalesTaxLineValues } from '@/lib/weldbooks/document-tax-form';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { DimensionSelects } from './dimension-selects';
import { LineTaxAmount, LineTaxFields, type LineTaxMode, type LineTaxResult } from './line-tax-fields';

interface InvoiceLineExtrasProps {
  idPrefix: string;
  /** The entity charges sales tax: the tax options are shown. Dimensions show for any entity that has some. */
  salesTax: boolean;
  mode: LineTaxMode;
  value: SalesTaxLineValues;
  onChange: (patch: Partial<SalesTaxLineValues>) => void;
  customerUse?: TaxUse | null;
  /** What the server calculated for the line (not for templates). */
  tax?: LineTaxResult | null;
  currency?: string | null;
  errors?: { taxOverrideAmount?: string; taxOverrideReason?: string };
}

/** The line has tax settings of its own (not the defaults), so its options start open. */
function hasCustomTax(value: SalesTaxLineValues): boolean {
  return Boolean(value.taxCode || value.taxUse || value.taxIncluded || value.taxOverrideEnabled);
}

/**
 * What a document line carries beyond description, quantity and price: the US
 * sales tax options (collapsed unless the line already departs from the
 * defaults), the tax the engine calculated for the line, and the class /
 * location pickers. VAT / GST entities see only the dimensions, when they have
 * any. A credit memo line has no options: its tax follows the original invoice.
 */
export function InvoiceLineExtras({
  idPrefix,
  salesTax,
  mode,
  value,
  onChange,
  customerUse,
  tax,
  currency,
  errors,
}: Readonly<InvoiceLineExtrasProps>) {
  const tl = useDocumentTexts().line;
  const [open, setOpen] = useState(() => hasCustomTax(value));
  // An error inside the options (a missing override reason) opens them so it can be seen.
  const expanded = open || Boolean(errors?.taxOverrideAmount || errors?.taxOverrideReason);

  const overridden =
    value.taxOverrideEnabled &&
    hasCompleteOverride({ taxOverrideAmount: value.taxOverrideAmount, taxOverrideReason: value.taxOverrideReason });

  return (
    <div className="space-y-3">
      {salesTax && mode === 'creditMemo' && <p className="text-xs text-muted-foreground">{tl.followsOriginal}</p>}

      {salesTax && mode !== 'creditMemo' && (
        <Collapsible open={expanded} onOpenChange={setOpen}>
          <CollapsibleTrigger
            type="button"
            className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
            {tl.taxOptions}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <LineTaxFields
              idPrefix={idPrefix}
              mode={mode}
              value={value}
              onChange={onChange}
              customerUse={customerUse}
              errors={errors}
            />
          </CollapsibleContent>
        </Collapsible>
      )}

      {salesTax && <LineTaxAmount idPrefix={idPrefix} tax={tax} currency={currency} overridden={overridden} />}

      <DimensionSelects
        idPrefix={idPrefix}
        classId={value.classId}
        locationId={value.locationId}
        onClassChange={(classId) => onChange({ classId })}
        onLocationChange={(locationId) => onChange({ locationId })}
      />
    </div>
  );
}
