'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Field } from '@/components/billing/action-dialog';
import { createPlan, updatePlan, type PlanFormValues } from '@/actions/plans';
import { adminCopy, fill } from '@/lib/i18n';
import { newRequestId } from '@/lib/billing-format';
import type { PlanDetail } from '@/lib/billing-types';

const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WHOLE = /^-?\d+$/;

/** Every input as the string the user typed; parsed on submit. */
interface FormState {
  name: string;
  slug: string;
  description: string;
  priceMonthly: string;
  priceYearly: string;
  currency: string;
  pricePerUser: string;
  includedUsers: string;
  monthlyCredits: string;
  creditsRolloverCap: string;
  maxUsers: string;
  maxProjects: string;
  maxCustomDomains: string;
  removeBranding: boolean;
  hasApiAccess: boolean;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: string;
  badge: string;
  color: string;
  features: string;
}

const str = (v: number | string | null | undefined) => (v == null ? '' : String(v));

function initialState(plan: PlanDetail | null): FormState {
  return {
    name: plan?.name ?? '',
    slug: plan?.slug ?? '',
    description: plan?.description ?? '',
    priceMonthly: plan?.priceMonthly ?? '0',
    priceYearly: plan?.priceYearly ?? '0',
    currency: plan?.currency ?? 'EUR',
    pricePerUser: str(plan?.pricePerUser),
    includedUsers: str(plan?.includedUsers ?? (plan ? null : 1)),
    monthlyCredits: str(plan?.monthlyCredits ?? 0),
    creditsRolloverCap: str(plan?.creditsRolloverCap),
    maxUsers: str(plan?.maxUsers),
    maxProjects: str(plan?.maxProjects),
    maxCustomDomains: str(plan?.maxCustomDomains),
    removeBranding: plan?.removeBranding ?? false,
    hasApiAccess: plan?.hasApiAccess ?? false,
    isActive: plan?.isActive ?? true,
    isDefault: plan?.isDefault ?? false,
    sortOrder: str(plan?.sortOrder ?? 0),
    badge: plan?.badge ?? '',
    color: plan?.color ?? '',
    features: JSON.stringify(plan?.features ?? {}, null, 2),
  };
}

type Parsed = { ok: true; values: PlanFormValues } | { ok: false; error: string };

function parse(form: FormState, t: ReturnType<typeof adminCopy>): Parsed {
  const f = t.plans.form;
  const optionalInt = (v: string): number | null | 'bad' => (v.trim() === '' ? null : WHOLE.test(v.trim()) ? Number(v.trim()) : 'bad');
  const optionalMoney = (v: string): string | null | 'bad' => (v.trim() === '' ? null : MONEY.test(v.trim()) ? v.trim() : 'bad');

  if (!form.name.trim()) return { ok: false, error: f.nameRequired };
  if (!MONEY.test(form.priceMonthly.trim())) return { ok: false, error: `${f.priceMonthly}: ${f.priceInvalid}` };
  if (!MONEY.test(form.priceYearly.trim())) return { ok: false, error: `${f.priceYearly}: ${f.priceInvalid}` };
  const pricePerUser = optionalMoney(form.pricePerUser);
  if (pricePerUser === 'bad') return { ok: false, error: `${f.pricePerUser}: ${f.priceInvalid}` };
  if (!/^[A-Za-z]{3}$/.test(form.currency.trim())) return { ok: false, error: f.currencyInvalid };

  const ints = {
    includedUsers: optionalInt(form.includedUsers),
    creditsRolloverCap: optionalInt(form.creditsRolloverCap),
    maxUsers: optionalInt(form.maxUsers),
    maxProjects: optionalInt(form.maxProjects),
    maxCustomDomains: optionalInt(form.maxCustomDomains),
  };
  for (const [key, value] of Object.entries(ints)) {
    if (value === 'bad' || (typeof value === 'number' && value < 0)) {
      return { ok: false, error: `${f[key as keyof typeof ints]}: ${f.wholeNumber}` };
    }
  }
  if (!WHOLE.test(form.monthlyCredits.trim()) || Number(form.monthlyCredits) < 0) {
    return { ok: false, error: `${f.monthlyCredits}: ${f.wholeNumber}` };
  }
  if (!WHOLE.test(form.sortOrder.trim())) return { ok: false, error: `${f.sortOrder}: ${f.wholeNumber}` };

  let features: unknown;
  try {
    features = JSON.parse(form.features || '{}');
  } catch {
    return { ok: false, error: f.featuresInvalid };
  }
  if (!features || typeof features !== 'object' || Array.isArray(features)) return { ok: false, error: f.featuresInvalid };

  return {
    ok: true,
    values: {
      name: form.name.trim(),
      description: form.description.trim() || null,
      priceMonthly: form.priceMonthly.trim(),
      priceYearly: form.priceYearly.trim(),
      currency: form.currency.trim().toUpperCase(),
      pricePerUser,
      includedUsers: ints.includedUsers as number | null,
      monthlyCredits: Number(form.monthlyCredits.trim()),
      creditsRolloverCap: ints.creditsRolloverCap as number | null,
      maxUsers: ints.maxUsers as number | null,
      maxProjects: ints.maxProjects as number | null,
      maxCustomDomains: ints.maxCustomDomains as number | null,
      removeBranding: form.removeBranding,
      hasApiAccess: form.hasApiAccess,
      isActive: form.isActive,
      isDefault: form.isDefault,
      sortOrder: Number(form.sortOrder.trim()),
      badge: form.badge.trim() || null,
      color: form.color.trim() || null,
      features: features as Record<string, unknown>,
    },
  };
}

/** Only the fields that differ from the saved plan (decimals compared as numbers). */
function changedFields(values: PlanFormValues, plan: PlanDetail): Partial<PlanFormValues> {
  const patch: Partial<PlanFormValues> = {};
  for (const key of Object.keys(values) as Array<keyof PlanFormValues>) {
    const next = values[key];
    const prev = (plan as unknown as Record<string, unknown>)[key];
    const same =
      key === 'features'
        ? JSON.stringify(next) === JSON.stringify(prev ?? {})
        : key === 'priceMonthly' || key === 'priceYearly' || key === 'pricePerUser'
          ? (next == null && prev == null) ||
            (next != null && prev != null && Number.parseFloat(String(next)) === Number.parseFloat(String(prev)))
          : next === prev;
    if (!same) (patch as Record<string, unknown>)[key] = next;
  }
  return patch;
}

export function PlanForm({ plan, canWrite }: Readonly<{ plan: PlanDetail | null; canWrite: boolean }>) {
  const t = adminCopy();
  const f = t.plans.form;
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => initialState(plan));
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const [isPending, startTransition] = useTransition();

  const set = <K extends keyof FormState>(key: K) => (value: FormState[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const text = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    set(key)(e.target.value as never);

  const priceTouched = useMemo(() => {
    if (!plan) return false;
    const changed = (a: string, b: string) => !MONEY.test(a.trim()) || Number.parseFloat(a) !== Number.parseFloat(b);
    return (
      changed(form.priceMonthly, plan.priceMonthly) ||
      changed(form.priceYearly, plan.priceYearly) ||
      form.currency.trim().toUpperCase() !== plan.currency
    );
  }, [form.priceMonthly, form.priceYearly, form.currency, plan]);

  const submit = () => {
    const parsed = parse(form, t);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    if (!plan && !SLUG.test(form.slug.trim())) {
      toast.error(`${f.slug}: ${f.slugInvalid}`);
      return;
    }
    const patch = plan ? changedFields(parsed.values, plan) : null;
    if (patch && Object.keys(patch).length === 0) {
      toast.info(f.noChanges);
      return;
    }

    startTransition(async () => {
      const result = plan
        ? await updatePlan(plan.id, { ...patch, reason: reason.trim() }, requestId)
        : await createPlan({ ...parsed.values, slug: form.slug.trim(), reason: reason.trim() }, requestId);
      setRequestId(newRequestId());
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(plan ? f.saved : f.created);
      if (result.data.stripeError) toast.warning(fill(f.stripeFailed, { message: result.data.stripeError }));
      setReason('');
      if (!plan) router.push(`/plans/${result.data.plan.id}`);
    });
  };

  const disabled = !canWrite || isPending;
  const reasonValid = reason.trim().length >= 3;

  return (
    <div className="space-y-4">
      <Section title={f.basics}>
        <div className="grid grid-cols-2 gap-4">
          <Field label={f.name} htmlFor="plan-name">
            <Input id="plan-name" value={form.name} onChange={text('name')} disabled={disabled} maxLength={100} />
          </Field>
          <Field label={f.slug} htmlFor="plan-slug" hint={f.slugHint}>
            <Input
              id="plan-slug"
              value={form.slug}
              onChange={text('slug')}
              disabled={disabled || plan !== null}
              className="font-mono"
              maxLength={100}
            />
          </Field>
        </div>
        <Field label={f.description} htmlFor="plan-description">
          <Textarea
            id="plan-description"
            value={form.description}
            onChange={text('description')}
            disabled={disabled}
            rows={2}
            className="resize-none"
          />
        </Field>
      </Section>

      <Section title={f.pricing}>
        <div className="grid grid-cols-3 gap-4">
          <Field label={f.priceMonthly} htmlFor="plan-price-monthly">
            <Input id="plan-price-monthly" inputMode="decimal" value={form.priceMonthly} onChange={text('priceMonthly')} disabled={disabled} />
          </Field>
          <Field label={f.priceYearly} htmlFor="plan-price-yearly" hint={f.priceYearlyHint}>
            <Input id="plan-price-yearly" inputMode="decimal" value={form.priceYearly} onChange={text('priceYearly')} disabled={disabled} />
          </Field>
          <Field label={f.currency} htmlFor="plan-currency">
            <Input id="plan-currency" value={form.currency} onChange={text('currency')} disabled={disabled} maxLength={3} className="uppercase" />
          </Field>
          <Field label={f.pricePerUser} htmlFor="plan-price-per-user" hint={f.pricePerUserHint}>
            <Input id="plan-price-per-user" inputMode="decimal" value={form.pricePerUser} onChange={text('pricePerUser')} disabled={disabled} />
          </Field>
          <Field label={f.includedUsers} htmlFor="plan-included-users">
            <Input id="plan-included-users" inputMode="numeric" value={form.includedUsers} onChange={text('includedUsers')} disabled={disabled} />
          </Field>
          <Field label={f.monthlyCredits} htmlFor="plan-credits">
            <Input id="plan-credits" inputMode="numeric" value={form.monthlyCredits} onChange={text('monthlyCredits')} disabled={disabled} />
          </Field>
          <Field label={f.creditsRolloverCap} htmlFor="plan-rollover" hint={f.creditsRolloverCapHint}>
            <Input id="plan-rollover" inputMode="numeric" value={form.creditsRolloverCap} onChange={text('creditsRolloverCap')} disabled={disabled} />
          </Field>
        </div>
        {priceTouched && <p className="text-xs text-amber-600 dark:text-amber-400">{f.priceChangeNote}</p>}
      </Section>

      <Section title={f.limits}>
        <div className="grid grid-cols-3 gap-4">
          <Field label={f.maxUsers} htmlFor="plan-max-users" hint={f.emptyIsUnlimited}>
            <Input id="plan-max-users" inputMode="numeric" value={form.maxUsers} onChange={text('maxUsers')} disabled={disabled} />
          </Field>
          <Field label={f.maxProjects} htmlFor="plan-max-projects" hint={f.emptyIsUnlimited}>
            <Input id="plan-max-projects" inputMode="numeric" value={form.maxProjects} onChange={text('maxProjects')} disabled={disabled} />
          </Field>
          <Field label={f.maxCustomDomains} htmlFor="plan-max-domains" hint={f.emptyIsUnlimited}>
            <Input id="plan-max-domains" inputMode="numeric" value={form.maxCustomDomains} onChange={text('maxCustomDomains')} disabled={disabled} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Toggle id="plan-remove-branding" label={f.removeBranding} checked={form.removeBranding} onChange={set('removeBranding')} disabled={disabled} />
          <Toggle id="plan-api" label={f.hasApiAccess} checked={form.hasApiAccess} onChange={set('hasApiAccess')} disabled={disabled} />
        </div>
      </Section>

      <Section title={f.display}>
        <div className="grid grid-cols-3 gap-4">
          <Field label={f.sortOrder} htmlFor="plan-sort">
            <Input id="plan-sort" inputMode="numeric" value={form.sortOrder} onChange={text('sortOrder')} disabled={disabled} />
          </Field>
          <Field label={f.badge} htmlFor="plan-badge">
            <Input id="plan-badge" value={form.badge} onChange={text('badge')} disabled={disabled} placeholder={f.badgePlaceholder} maxLength={50} />
          </Field>
          <Field label={f.color} htmlFor="plan-color">
            <Input id="plan-color" value={form.color} onChange={text('color')} disabled={disabled} maxLength={20} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Toggle id="plan-active" label={f.isActive} checked={form.isActive} onChange={set('isActive')} disabled={disabled} />
          <Toggle id="plan-default" label={f.isDefault} checked={form.isDefault} onChange={set('isDefault')} disabled={disabled} />
        </div>
      </Section>

      <Section title={f.features}>
        <Field label={f.featuresJson} htmlFor="plan-features" hint={f.featuresHint}>
          <Textarea
            id="plan-features"
            value={form.features}
            onChange={text('features')}
            disabled={disabled}
            rows={10}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </Field>
      </Section>

      {canWrite && (
        <Card className="py-4">
          <CardContent className="space-y-3 px-4">
            <Field label={t.common.reason} htmlFor="plan-reason">
              <Textarea
                id="plan-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder={t.common.reasonPlaceholder}
                className="resize-none"
              />
            </Field>
            <div className="flex justify-end">
              <Button disabled={isPending || !reasonValid} onClick={submit}>
                {isPending ? t.common.working : plan ? f.submitSave : f.submitCreate}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <Card className="py-4">
      <CardContent className="space-y-4 px-4">
        <h2 className="text-sm font-medium">{title}</h2>
        {children}
      </CardContent>
    </Card>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
  disabled,
}: Readonly<{ id: string; label: string; checked: boolean; onChange: (value: boolean) => void; disabled: boolean }>) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} />
      {label}
    </label>
  );
}
