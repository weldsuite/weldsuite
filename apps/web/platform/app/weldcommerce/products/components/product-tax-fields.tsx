import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { getTranslations } from '@/lib/i18n';
import { WELD_TAX_CODES } from '@/lib/weldbooks/tax-codes';
import {
  TAX_CODE_CUSTOM,
  TAX_CODE_DEFAULT,
  hasInvalidCustomCode,
  type ProductTaxState,
  type TaxCodeChoice,
} from './product-tax';

/**
 * "Sales tax" section of the product form: whether the product is taxable and
 * which tax code WeldBooks invoices and WeldCommerce orders use for it. The
 * state lives in the dialog (see `product-tax.ts`); nothing here calls the API.
 */
export function ProductTaxFields({
  state,
  onChange,
  showErrors,
}: Readonly<{
  state: ProductTaxState;
  onChange: (next: ProductTaxState) => void;
  /** Show the custom code's problem; set once a save was attempted. */
  showErrors: boolean;
}>) {
  const t = getTranslations('commerce').module.products;
  const customInvalid = showErrors && state.taxable && hasInvalidCustomCode(state);

  return (
    <fieldset className="grid gap-3 rounded-md border p-3" data-testid="product-tax-fields">
      <legend className="px-1 text-sm font-medium">{t.taxSection}</legend>
      <p className="text-xs text-muted-foreground">{t.taxSectionHint}</p>

      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <Label htmlFor="product-taxable">{t.taxable}</Label>
          <p className="text-xs text-muted-foreground">{t.taxableHint}</p>
        </div>
        <Switch
          id="product-taxable"
          checked={state.taxable}
          onCheckedChange={(taxable) => onChange({ ...state, taxable })}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="product-tax-code">{t.taxCode}</Label>
        <Select
          value={state.choice}
          disabled={!state.taxable}
          onValueChange={(choice) => onChange({ ...state, choice: choice as TaxCodeChoice, touched: true })}
        >
          <SelectTrigger id="product-tax-code" aria-label={t.taxCode}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TAX_CODE_DEFAULT}>{t.taxCodeDefault}</SelectItem>
            {WELD_TAX_CODES.map((code) => (
              <SelectItem key={code} value={code}>
                {t.taxCodes[code]}
              </SelectItem>
            ))}
            <SelectItem value={TAX_CODE_CUSTOM}>{t.taxCodeCustom}</SelectItem>
          </SelectContent>
        </Select>
        {!state.taxable && <p className="text-xs text-muted-foreground">{t.taxCodeDisabledHint}</p>}
      </div>

      {state.choice === TAX_CODE_CUSTOM && (
        <div className="grid gap-1.5">
          <Label htmlFor="product-tax-custom">{t.taxCodeCustomLabel}</Label>
          <Input
            id="product-tax-custom"
            value={state.custom}
            disabled={!state.taxable}
            placeholder={t.taxCodeCustomPlaceholder}
            maxLength={50}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={customInvalid || undefined}
            onChange={(event) => onChange({ ...state, custom: event.target.value, touched: true })}
          />
          {customInvalid ? (
            <p role="alert" className="text-xs text-destructive">
              {t.taxCodeCustomInvalid}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t.taxCodeCustomHint}</p>
          )}
        </div>
      )}
    </fieldset>
  );
}
