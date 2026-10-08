import { useMemo } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { countryOptions } from './countries';
import { US_STATES, toUsStateCode } from './us-states';
import type { PostalAddress } from './postal-address';

const NO_COUNTRY = '__none__';

interface AddressFieldsProps {
  /** The address being edited. Missing fields are treated as empty. */
  value: PostalAddress | null | undefined;
  onChange: (next: PostalAddress) => void;
  /** Prefix for the input ids, so several address blocks can share a page. */
  idPrefix: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Postal address inputs in the shared `PostalAddress` shape. When the country
 * is the United States the region becomes a state picker (50 states + DC,
 * stored as the USPS code) and the postal code is labelled "ZIP code".
 */
export function AddressFields({ value, onChange, idPrefix, disabled, className }: Readonly<AddressFieldsProps>) {
  const { t, language } = useI18n();
  const ta = t.accounting.addressFields;
  const address = value ?? {};
  const country = address.country?.trim().toUpperCase() ?? '';
  const isUs = country === 'US';

  const countries = useMemo(() => countryOptions(language || 'en'), [language]);

  const update = (patch: Partial<PostalAddress>) => onChange({ ...address, ...patch });

  const handleCountryChange = (next: string) => {
    const code = next === NO_COUNTRY ? '' : next;
    // Moving to the US: turn a typed state name into its USPS code so the picker shows it.
    const state = code === 'US' ? toUsStateCode(address.state) : address.state;
    update({ country: code, state: state ?? '' });
  };

  const id = (field: string) => `${idPrefix}-${field}`;
  const stateValue = isUs ? toUsStateCode(address.state) : address.state ?? '';

  return (
    <div className={cn('grid grid-cols-1 sm:grid-cols-2 gap-4', className)}>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={id('line1')}>{ta.line1}</Label>
        <Input
          id={id('line1')}
          value={address.line1 ?? ''}
          placeholder={ta.line1Placeholder}
          autoComplete="address-line1"
          disabled={disabled}
          onChange={(e) => update({ line1: e.target.value })}
        />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={id('line2')}>{ta.line2}</Label>
        <Input
          id={id('line2')}
          value={address.line2 ?? ''}
          placeholder={ta.line2Placeholder}
          autoComplete="address-line2"
          disabled={disabled}
          onChange={(e) => update({ line2: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={id('city')}>{ta.city}</Label>
        <Input
          id={id('city')}
          value={address.city ?? ''}
          autoComplete="address-level2"
          disabled={disabled}
          onChange={(e) => update({ city: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={id('state')}>{isUs ? ta.stateUs : ta.state}</Label>
        {isUs ? (
          <Select
            value={stateValue || undefined}
            onValueChange={(next) => update({ state: next })}
            disabled={disabled}
          >
            <SelectTrigger id={id('state')}>
              <SelectValue placeholder={ta.selectState} />
            </SelectTrigger>
            <SelectContent>
              {US_STATES.map((s) => (
                <SelectItem key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={id('state')}
            value={stateValue}
            autoComplete="address-level1"
            disabled={disabled}
            onChange={(e) => update({ state: e.target.value })}
          />
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={id('postalCode')}>{isUs ? ta.zipCode : ta.postalCode}</Label>
        <Input
          id={id('postalCode')}
          value={address.postalCode ?? ''}
          autoComplete="postal-code"
          inputMode={isUs ? 'numeric' : undefined}
          disabled={disabled}
          onChange={(e) => update({ postalCode: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={id('country')}>{ta.country}</Label>
        <Select value={country || NO_COUNTRY} onValueChange={handleCountryChange} disabled={disabled}>
          <SelectTrigger id={id('country')}>
            <SelectValue placeholder={ta.selectCountry} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={NO_COUNTRY}>{ta.noCountry}</SelectItem>
            {countries.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
