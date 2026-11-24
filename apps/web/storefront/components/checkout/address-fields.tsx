import type { Address } from '@weldsuite/commerce-sdk'
import { useCountryName, useShop } from '@weldsuite/storefront-theme'
import { useId } from 'react'
import { Field, useFormState } from '../shop-form'

type Section = 'shipping' | 'billing'

/**
 * One address, with the autocomplete tokens that let browsers fill it in,
 * scoped with "shipping" / "billing" so both can be autofilled.
 */
export function AddressFields({
  section,
  address,
  countries,
  required,
}: Readonly<{
  section: Section
  address: Address | null
  countries: string[]
  /** Billing fields are checked on the server: they may be hidden. */
  required: boolean
}>) {
  const { shop } = useShop()
  const s = shop.strings.checkout
  const countryName = useCountryName()
  const { result } = useFormState()
  const prefix = section === 'shipping' ? 'shippingAddress' : 'billingAddress'
  const countryId = useId()
  const countryError = result && !result.ok ? result.fieldErrors?.[`${prefix}.country`] : undefined
  const sorted = countries
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, shop.intlLocale))
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field className="sm:col-span-2" name={`${prefix}.name`} label={s.fullName} autoComplete={`${section} name`} defaultValue={address?.name ?? ''} required={required} maxLength={255} />
      <Field className="sm:col-span-2" name={`${prefix}.company`} label={s.company} optional autoComplete={`${section} organization`} defaultValue={address?.company ?? ''} maxLength={255} />
      <Field className="sm:col-span-2" name={`${prefix}.line1`} label={s.line1} autoComplete={`${section} address-line1`} defaultValue={address?.line1 ?? ''} required={required} maxLength={255} />
      <Field className="sm:col-span-2" name={`${prefix}.line2`} label={s.line2} optional autoComplete={`${section} address-line2`} defaultValue={address?.line2 ?? ''} maxLength={255} />
      <Field
        name={`${prefix}.postalCode`}
        label={s.postalCode}
        autoComplete={`${section} postal-code`}
        defaultValue={address?.postalCode ?? ''}
        required={required}
        maxLength={30}
        autoCapitalize="characters"
        spellCheck={false}
      />
      <Field name={`${prefix}.city`} label={s.city} autoComplete={`${section} address-level2`} defaultValue={address?.city ?? ''} required={required} maxLength={120} />
      <Field name={`${prefix}.region`} label={s.region} optional autoComplete={`${section} address-level1`} defaultValue={address?.region ?? ''} maxLength={120} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={countryId} className="shop-label">
          {s.country}
        </label>
        <select
          id={countryId}
          name={`${prefix}.country`}
          autoComplete={`${section} country`}
          defaultValue={address?.country ?? (sorted.length === 1 ? sorted[0]?.code : '')}
          required={required}
          aria-invalid={countryError ? true : undefined}
          aria-describedby={countryError ? `${countryId}-error` : undefined}
          className="shop-input"
        >
          {sorted.length > 1 ? <option value="">{s.chooseCountry}</option> : null}
          {sorted.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
        {countryError ? (
          <p id={`${countryId}-error`} className="shop-field-error">
            {countryError}
          </p>
        ) : null}
      </div>
      <Field
        className="sm:col-span-2"
        name={`${prefix}.phone`}
        label={s.phone}
        optional
        type="tel"
        autoComplete={`${section} tel`}
        defaultValue={address?.phone ?? ''}
        maxLength={50}
        hint={section === 'shipping' ? s.phoneHint : undefined}
      />
    </div>
  )
}
