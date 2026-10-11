'use client';

import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Field } from '@/components/billing/action-dialog';
import type { ContractFormState } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { PlanOption } from '@/lib/billing-types';

/** The contract terms, shared by the new-partner form and the new-contract form. */
export function ContractFields({
  value,
  onChange,
  disabled,
  planOptions,
  idPrefix,
  showEffectiveFrom = true,
}: Readonly<{
  value: ContractFormState;
  onChange: (next: ContractFormState) => void;
  disabled: boolean;
  planOptions: PlanOption[];
  idPrefix: string;
  /** The first contract of a new partner always starts now. */
  showEffectiveFrom?: boolean;
}>) {
  const c = partnersCopy().contract;
  const set = <K extends keyof ContractFormState>(key: K) => (v: ContractFormState[K]) => onChange({ ...value, [key]: v });
  const text = (key: Exclude<keyof ContractFormState, 'allowedFeaturePlanIds'>) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key)(e.target.value);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={c.revenueShare} htmlFor={`${idPrefix}-share`} hint={c.revenueShareHint}>
          <Input id={`${idPrefix}-share`} inputMode="decimal" value={value.revenueSharePercent} onChange={text('revenueSharePercent')} disabled={disabled} />
        </Field>
        <Field label={c.baseMinimum} htmlFor={`${idPrefix}-minimum`}>
          <Input id={`${idPrefix}-minimum`} inputMode="decimal" value={value.baseMinimum} onChange={text('baseMinimum')} disabled={disabled} placeholder="50.00" />
        </Field>
        <Field label={c.includedCredits} htmlFor={`${idPrefix}-included`}>
          <Input id={`${idPrefix}-included`} inputMode="numeric" value={value.includedCredits} onChange={text('includedCredits')} disabled={disabled} />
        </Field>
        <Field label={c.creditFloorPrice} htmlFor={`${idPrefix}-floor`} hint={c.creditFloorPriceHint}>
          <Input id={`${idPrefix}-floor`} inputMode="decimal" value={value.creditFloorPrice} onChange={text('creditFloorPrice')} disabled={disabled} />
        </Field>
        <Field label={c.extraCreditPrice} htmlFor={`${idPrefix}-extra`}>
          <Input id={`${idPrefix}-extra`} inputMode="decimal" value={value.extraCreditPrice} onChange={text('extraCreditPrice')} disabled={disabled} />
        </Field>
        {showEffectiveFrom && (
          <Field label={c.effectiveFrom} htmlFor={`${idPrefix}-from`} hint={c.effectiveFromHint}>
            <Input id={`${idPrefix}-from`} type="date" value={value.effectiveFrom} onChange={text('effectiveFrom')} disabled={disabled} />
          </Field>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={c.paymentTerms} htmlFor={`${idPrefix}-terms`}>
          <Input id={`${idPrefix}-terms`} inputMode="numeric" value={value.paymentTermsDays} onChange={text('paymentTermsDays')} disabled={disabled} />
        </Field>
        <Field label={c.pastDueAfter} htmlFor={`${idPrefix}-past-due`}>
          <Input id={`${idPrefix}-past-due`} inputMode="numeric" value={value.pastDueAfterDays} onChange={text('pastDueAfterDays')} disabled={disabled} />
        </Field>
        <Field label={c.readOnlyAfter} htmlFor={`${idPrefix}-read-only`}>
          <Input id={`${idPrefix}-read-only`} inputMode="numeric" value={value.readOnlyAfterDays} onChange={text('readOnlyAfterDays')} disabled={disabled} />
        </Field>
      </div>

      <Field label={c.featurePlans} hint={c.featurePlansHint}>
        <MultiSelect
          options={planOptions.map((p) => ({ value: p.id, label: p.name }))}
          value={value.allowedFeaturePlanIds}
          onChange={set('allowedFeaturePlanIds')}
          disabled={disabled}
          placeholder={c.featurePlans}
          aria-label={c.featurePlans}
          modal
        />
      </Field>

      <Field label={c.notes} htmlFor={`${idPrefix}-notes`}>
        <Textarea id={`${idPrefix}-notes`} value={value.notes} onChange={text('notes')} disabled={disabled} rows={2} maxLength={5000} className="resize-none" />
      </Field>
    </div>
  );
}
