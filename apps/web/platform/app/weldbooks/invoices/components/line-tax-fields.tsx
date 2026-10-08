import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type { TaxUse } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import type { SalesTaxLineValues } from '@/lib/weldbooks/document-tax-form';
import { DEFAULT_WELD_TAX_CODE, WELD_TAX_CODES } from '@/lib/weldbooks/tax-codes';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** Select value of the default tax code / use; never stored. */
const DEFAULT = '__default__';

export type LineTaxMode =
  /** An invoice or estimate line: code, use, tax included and an override. */
  | 'invoice'
  /** A recurring template line: no amounts exist yet, so no override. */
  | 'template'
  /** A credit memo line: the tax follows the invoice it credits. */
  | 'creditMemo';

/** What the server calculated for a line. */
export interface LineTaxResult {
  amount: string | number | null;
  rate: string | number | null;
}

interface LineTaxAmountProps {
  idPrefix: string;
  tax?: LineTaxResult | null;
  currency?: string | null;
  /** The line's tax was set by hand (an override with amount and reason). */
  overridden?: boolean;
}

/** The sales tax the engine calculated for a line, marked when it was overridden. */
export function LineTaxAmount({ idPrefix, tax, currency, overridden }: Readonly<LineTaxAmountProps>) {
  const tl = useDocumentTexts().line;
  const { formatMoney } = useWeldbooksFormat();
  if (!tax || tax.amount === null || tax.amount === undefined) return null;
  const hasRate = tax.rate !== null && tax.rate !== undefined && Number(tax.rate) > 0;
  return (
    <p
      className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground"
      data-testid={`${idPrefix}-line-tax`}
    >
      {overridden && <Badge variant="outline">{tl.overridden}</Badge>}
      <span>
        {hasRate
          ? tl.lineTaxRate.replace('{amount}', formatMoney(tax.amount, currency)).replace('{rate}', String(Number(tax.rate)))
          : tl.lineTax.replace('{amount}', formatMoney(tax.amount, currency))}
      </span>
    </p>
  );
}

interface LineTaxFieldsProps {
  idPrefix: string;
  mode: Exclude<LineTaxMode, 'creditMemo'>;
  value: SalesTaxLineValues;
  onChange: (patch: Partial<SalesTaxLineValues>) => void;
  /** The customer's default use, named on the "customer default" option. */
  customerUse?: TaxUse | null;
  errors?: { taxOverrideAmount?: string; taxOverrideReason?: string };
}

/**
 * The US sales tax controls of one document line: tax code, business or
 * personal use, tax-inclusive price and a hand-set tax with its reason.
 * Nothing here calculates tax; the engine's answer is shown by
 * {@link LineTaxAmount}.
 */
export function LineTaxFields({
  idPrefix,
  mode,
  value,
  onChange,
  customerUse,
  errors,
}: Readonly<LineTaxFieldsProps>) {
  const td = useDocumentTexts();
  const tl = td.line;

  const defaultCode = td.taxCodes[DEFAULT_WELD_TAX_CODE];
  const defaultUse = customerUse === 'personal' ? tl.usePersonal : tl.useBusiness;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-taxCode`} className="text-xs">
            {tl.taxCode}
          </Label>
          <Select
            value={value.taxCode || DEFAULT}
            onValueChange={(next) => onChange({ taxCode: next === DEFAULT ? '' : next })}
          >
            <SelectTrigger id={`${idPrefix}-taxCode`} className="shadow-none" aria-label={tl.taxCode}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{tl.taxCodeDefault.replace('{code}', defaultCode)}</SelectItem>
              {WELD_TAX_CODES.map((code) => (
                <SelectItem key={code} value={code}>
                  {td.taxCodes[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-taxUse`} className="text-xs">
            {tl.use}
          </Label>
          <Select
            value={value.taxUse || DEFAULT}
            onValueChange={(next) => onChange({ taxUse: next === DEFAULT ? '' : (next as TaxUse) })}
          >
            <SelectTrigger id={`${idPrefix}-taxUse`} className="shadow-none" aria-label={tl.use}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{tl.useDefault.replace('{use}', defaultUse)}</SelectItem>
              <SelectItem value="business">{tl.useBusiness}</SelectItem>
              <SelectItem value="personal">{tl.usePersonal}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <label
          className="flex items-center gap-2 text-sm sm:self-end sm:pb-2"
          htmlFor={`${idPrefix}-taxIncluded`}
        >
          <Checkbox
            id={`${idPrefix}-taxIncluded`}
            checked={value.taxIncluded}
            onCheckedChange={(checked) => onChange({ taxIncluded: checked === true })}
          />
          {tl.taxIncluded}
        </label>
      </div>

      {mode === 'invoice' && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-overrideTax`}>
            <Checkbox
              id={`${idPrefix}-overrideTax`}
              checked={value.taxOverrideEnabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? { taxOverrideEnabled: true }
                    : { taxOverrideEnabled: false, taxOverrideAmount: '', taxOverrideReason: '' },
                )
              }
            />
            {tl.overrideTax}
          </label>

          {value.taxOverrideEnabled && (
            <div className="space-y-2 rounded-md border border-dashed border-border p-3">
              <p className="text-xs text-muted-foreground">{tl.overrideHelp}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-overrideAmount`} className="text-xs">
                    {tl.overrideAmount}
                  </Label>
                  <Input
                    id={`${idPrefix}-overrideAmount`}
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    className="shadow-none"
                    value={value.taxOverrideAmount}
                    onChange={(e) => onChange({ taxOverrideAmount: e.target.value })}
                    aria-invalid={Boolean(errors?.taxOverrideAmount)}
                  />
                  {errors?.taxOverrideAmount && <p className="text-xs text-destructive">{errors.taxOverrideAmount}</p>}
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor={`${idPrefix}-overrideReason`} className="text-xs">
                    {tl.overrideReason}
                  </Label>
                  <Input
                    id={`${idPrefix}-overrideReason`}
                    className="shadow-none"
                    maxLength={255}
                    placeholder={tl.overrideReasonPlaceholder}
                    value={value.taxOverrideReason}
                    onChange={(e) => onChange({ taxOverrideReason: e.target.value })}
                    aria-invalid={Boolean(errors?.taxOverrideReason)}
                  />
                  {errors?.taxOverrideReason && <p className="text-xs text-destructive">{errors.taxOverrideReason}</p>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
