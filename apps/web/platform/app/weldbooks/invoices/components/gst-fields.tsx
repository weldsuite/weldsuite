import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { IN_STATES } from '@/components/address/in-states';
import type { TaxBreakdownRow } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { GST_FOREIGN_COUNTRY_CODE, gstSplitRows, isGstSplit, placeOfSupplyName } from '@/lib/weldbooks/gst';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** Select value for "derive it from the customer": the form stores '' and the API derives the state. */
const AUTO = '__auto__';

interface PlaceOfSupplySelectProps {
  id: string;
  /** The chosen two-digit code; '' lets the API derive it from the customer's GSTIN or address. */
  value: string;
  onChange: (next: string) => void;
  /** The place the server worked out for the current form state (shown next to "Automatic"). */
  derived?: string | null;
  /** True once a calculation answered: the tax can't be split while the place stays unknown. */
  showUnknownNotice?: boolean;
  disabled?: boolean;
}

/** India GST: the state the supply is made in, which decides CGST + SGST versus IGST. */
export function PlaceOfSupplySelect({
  id,
  value,
  onChange,
  derived,
  showUnknownNotice,
  disabled,
}: Readonly<PlaceOfSupplySelectProps>) {
  const { t } = useI18n();
  const tg = t.weldbooksIn.gst;
  const outside = tg.placeOfSupplyOutside;
  const autoLabel = derived
    ? tg.placeOfSupplyAutoWith.replace('{place}', placeOfSupplyName(derived, outside))
    : tg.placeOfSupplyAuto;

  return (
    <div className="space-y-2" data-testid="place-of-supply">
      <Label htmlFor={id}>{tg.placeOfSupply}</Label>
      <Select
        value={value || AUTO}
        onValueChange={(next) => onChange(next === AUTO ? '' : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="shadow-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value={AUTO}>{autoLabel}</SelectItem>
          {IN_STATES.map((state) => (
            <SelectItem key={state.code} value={state.code}>
              {state.name} ({state.code})
            </SelectItem>
          ))}
          <SelectItem value={GST_FOREIGN_COUNTRY_CODE}>{outside}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{tg.placeOfSupplyHelp}</p>
      {showUnknownNotice && !value && !derived && (
        <InfoBanner variant="warning">
          <span data-testid="place-of-supply-unknown">{tg.placeOfSupplyUnknown}</span>
        </InfoBanner>
      )}
    </div>
  );
}

interface GstTaxSplitProps {
  rows: readonly TaxBreakdownRow[] | null | undefined;
  currency?: string | null;
}

/** The server's CGST / SGST / IGST rows of a draft, under the totals. Nothing while the slab is not split. */
export function GstTaxSplit({ rows, currency }: Readonly<GstTaxSplitProps>) {
  const { t } = useI18n();
  const { formatMoney } = useWeldbooksFormat();
  const tg = t.weldbooksIn.gst;
  if (!isGstSplit(rows)) return null;
  const split = gstSplitRows(rows).filter((row) => row.component !== 'export');
  if (split.length === 0) return null;
  const labelOf = (component: string): string =>
    (tg.components as Record<string, string>)[component] ?? tg.components.other;

  return (
    <div className="space-y-1" data-testid="gst-split">
      <p className="text-xs font-medium text-muted-foreground">{tg.splitTitle}</p>
      <ul className="space-y-1 text-sm">
        {split.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {tg.splitRow
                .replace('{label}', labelOf(row.component))
                .replace('{rate}', String(row.rate))
                .replace('{amount}', formatMoney(row.taxableAmount, currency ?? undefined))}
            </span>
            <span className="tabular-nums">{formatMoney(row.taxAmount, currency ?? undefined)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
