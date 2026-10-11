'use client';

import { Input } from '@weldsuite/ui/components/input';
import { Field } from '@/components/billing/action-dialog';
import type { ProfileFormState } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';

/** The partner's company profile, shared by the new-partner form and the Profile tab. */
export function ProfileFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: Readonly<{ value: ProfileFormState; onChange: (next: ProfileFormState) => void; disabled: boolean; idPrefix: string }>) {
  const p = partnersCopy().profile;
  const text = (key: keyof ProfileFormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: e.target.value });

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label={p.name} htmlFor={`${idPrefix}-name`}>
        <Input id={`${idPrefix}-name`} value={value.name} onChange={text('name')} disabled={disabled} maxLength={255} />
      </Field>
      <Field label={p.legalName} htmlFor={`${idPrefix}-legal`}>
        <Input id={`${idPrefix}-legal`} value={value.legalName} onChange={text('legalName')} disabled={disabled} maxLength={255} />
      </Field>
      <Field label={p.country} htmlFor={`${idPrefix}-country`}>
        <Input id={`${idPrefix}-country`} value={value.country} onChange={text('country')} disabled={disabled} maxLength={2} className="uppercase" />
      </Field>
      <Field label={p.taxId} htmlFor={`${idPrefix}-tax`}>
        <Input id={`${idPrefix}-tax`} value={value.taxId} onChange={text('taxId')} disabled={disabled} maxLength={100} />
      </Field>
      <Field label={p.billingEmail} htmlFor={`${idPrefix}-billing`} hint={p.billingEmailHint}>
        <Input id={`${idPrefix}-billing`} type="email" value={value.billingEmail} onChange={text('billingEmail')} disabled={disabled} maxLength={255} />
      </Field>
      <Field label={p.supportEmail} htmlFor={`${idPrefix}-support-email`}>
        <Input id={`${idPrefix}-support-email`} type="email" value={value.supportEmail} onChange={text('supportEmail')} disabled={disabled} maxLength={255} />
      </Field>
      <Field label={p.supportUrl} htmlFor={`${idPrefix}-support-url`}>
        <Input id={`${idPrefix}-support-url`} value={value.supportUrl} onChange={text('supportUrl')} disabled={disabled} maxLength={500} placeholder="https://" />
      </Field>
      <Field label={p.websiteUrl} htmlFor={`${idPrefix}-website`}>
        <Input id={`${idPrefix}-website`} value={value.websiteUrl} onChange={text('websiteUrl')} disabled={disabled} maxLength={500} placeholder="https://" />
      </Field>
      <Field label={p.logoUrl} htmlFor={`${idPrefix}-logo`}>
        <Input id={`${idPrefix}-logo`} value={value.logoUrl} onChange={text('logoUrl')} disabled={disabled} maxLength={500} placeholder="https://" />
      </Field>
    </div>
  );
}
