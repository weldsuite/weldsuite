'use client';

import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Field } from '@/components/billing/action-dialog';
import type { PlanOption } from '@/lib/billing-types';
import type { LicenceFormState } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';

export interface AppOption {
  code: string;
  name: string;
}

const NO_PLAN = '__none__';

/** The licence terms: apps, credits, seats, feature plan and the customer price. */
export function LicenceFields({
  value,
  onChange,
  disabled,
  appOptions,
  planOptions,
  idPrefix,
}: Readonly<{
  value: LicenceFormState;
  onChange: (next: LicenceFormState) => void;
  disabled: boolean;
  appOptions: AppOption[];
  planOptions: PlanOption[];
  idPrefix: string;
}>) {
  const l = partnersCopy().workspaces.licence;
  const set = <K extends keyof LicenceFormState>(key: K) => (v: LicenceFormState[K]) => onChange({ ...value, [key]: v });
  const text = (key: Exclude<keyof LicenceFormState, 'allowedApps' | 'pricingModel'>) =>
    (e: React.ChangeEvent<HTMLInputElement>) => set(key)(e.target.value);

  return (
    <div className="space-y-4">
      <Field label={l.apps}>
        <MultiSelect
          options={appOptions.map((a) => ({ value: a.code, label: a.name }))}
          value={value.allowedApps}
          onChange={set('allowedApps')}
          disabled={disabled}
          placeholder={l.appsPlaceholder}
          searchPlaceholder={l.appsSearch}
          emptyText={l.appsEmpty}
          aria-label={l.apps}
          modal
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={l.credits} htmlFor={`${idPrefix}-credits`}>
          <Input id={`${idPrefix}-credits`} inputMode="numeric" value={value.monthlyCredits} onChange={text('monthlyCredits')} disabled={disabled} />
        </Field>
        <Field label={l.rollover} htmlFor={`${idPrefix}-rollover`} hint={l.rolloverHint}>
          <Input id={`${idPrefix}-rollover`} inputMode="numeric" value={value.creditRolloverCap} onChange={text('creditRolloverCap')} disabled={disabled} />
        </Field>
        <Field label={l.maxSeats} htmlFor={`${idPrefix}-seats`} hint={l.maxSeatsHint}>
          <Input id={`${idPrefix}-seats`} inputMode="numeric" value={value.maxSeats} onChange={text('maxSeats')} disabled={disabled} />
        </Field>
        <Field label={l.storage} htmlFor={`${idPrefix}-storage`} hint={l.storageHint}>
          <Input id={`${idPrefix}-storage`} inputMode="numeric" value={value.storageGb} onChange={text('storageGb')} disabled={disabled} />
        </Field>
        <Field label={l.featurePlan}>
          <Select
            value={value.featurePlanId === '' ? NO_PLAN : value.featurePlanId}
            onValueChange={(v) => set('featurePlanId')(v === NO_PLAN ? '' : v)}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PLAN}>{l.featurePlanNone}</SelectItem>
              {planOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{l.pricing}</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={l.pricingModel}>
            <Select value={value.pricingModel} onValueChange={(v) => set('pricingModel')(v as 'flat' | 'per_seat')} disabled={disabled}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="flat">{l.flatModel}</SelectItem>
                <SelectItem value="per_seat">{l.perSeatModel}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={l.amount} htmlFor={`${idPrefix}-amount`}>
            <Input id={`${idPrefix}-amount`} inputMode="decimal" value={value.amount} onChange={text('amount')} disabled={disabled} placeholder="199.00" />
          </Field>
          {value.pricingModel === 'per_seat' && (
            <Field label={l.minSeats} htmlFor={`${idPrefix}-min-seats`}>
              <Input id={`${idPrefix}-min-seats`} inputMode="numeric" value={value.minSeats} onChange={text('minSeats')} disabled={disabled} />
            </Field>
          )}
        </div>
      </div>
    </div>
  );
}
