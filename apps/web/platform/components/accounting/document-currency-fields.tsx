import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { currencyOptions, isForeignCurrency, parseExchangeRateInput } from '@/lib/weldbooks/currencies';

interface DocumentCurrencyFieldsProps {
  /** Prefix of the field ids, so two documents on a page do not clash. */
  idPrefix: string;
  /** The entity's base currency. */
  baseCurrency: string | null | undefined;
  currency: string;
  onCurrencyChange: (currency: string) => void;
  /** The typed exchange rate; empty = the rate of the document date. */
  exchangeRate: string;
  onExchangeRateChange: (rate: string) => void;
  /** The rate the server stored on the document, shown as a hint while the field is empty. */
  storedRate?: string | null;
  /** Posted documents keep their currency and rate. */
  disabled?: boolean;
}

/**
 * Currency picker and, only when the currency is not the entity's base, the
 * exchange rate override (foreign units per base unit).
 */
export function DocumentCurrencyFields({
  idPrefix,
  baseCurrency,
  currency,
  onCurrencyChange,
  exchangeRate,
  onExchangeRateChange,
  storedRate,
  disabled,
}: Readonly<DocumentCurrencyFieldsProps>) {
  const { t } = useI18n();
  const tc = t.accounting.documentCurrency;
  const foreign = isForeignCurrency(baseCurrency, currency);
  const invalidRate = parseExchangeRateInput(exchangeRate) === undefined;
  const hint = (storedRate ? Number(storedRate) : 0) > 0 ? Number(storedRate) : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-currency`}>{tc.currency}</Label>
        <Select value={currency} onValueChange={onCurrencyChange} disabled={disabled}>
          <SelectTrigger id={`${idPrefix}-currency`} className="shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {currencyOptions(currency, baseCurrency).map((code) => (
              <SelectItem key={code} value={code}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {foreign && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-exchangeRate`}>{tc.exchangeRate}</Label>
          <Input
            id={`${idPrefix}-exchangeRate`}
            inputMode="decimal"
            className="shadow-none"
            placeholder={hint ? String(hint) : tc.exchangeRateAutomatic}
            value={exchangeRate}
            disabled={disabled}
            aria-invalid={invalidRate}
            onChange={(event) => onExchangeRateChange(event.target.value)}
          />
          <p className={invalidRate ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}>
            {invalidRate
              ? tc.exchangeRateInvalid
              : tc.exchangeRateHelp.replace('{base}', baseCurrency ?? '').replace('{currency}', currency)}
          </p>
        </div>
      )}
    </div>
  );
}
