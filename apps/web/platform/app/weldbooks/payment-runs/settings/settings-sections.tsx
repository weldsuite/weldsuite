import type { ReactNode } from 'react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { AlertTriangle, Printer } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import type { UsBankAccount } from '@/lib/api/domains/weldbooks-banking';
import {
  ACH_SEC_CODES,
  type BankPaymentSettings,
  type CheckLayoutId,
  type Readiness,
} from '@/lib/api/domains/weldbooks-payment-runs';
import { maskedCompanyId, type SettingsFormValues } from './settings-model';

type Form = UseFormReturn<SettingsFormValues>;

function Field({
  id,
  label,
  hint,
  error,
  children,
}: Readonly<{ id: string; label: string; hint?: string; error?: string; children: ReactNode }>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: Readonly<{ id: string; label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }>) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Readiness

export function ReadinessCard({ settings }: Readonly<{ settings: BankPaymentSettings }>) {
  const { t } = useI18n();
  const ts = t.weldbooksUs.payments.settings;
  const labels: Readonly<Record<string, string>> = ts.missing;
  const rows: Array<{ key: 'checks' | 'ach' | 'positivePay'; readiness: Readiness }> = [
    { key: 'checks', readiness: settings.readiness.checks },
    { key: 'ach', readiness: settings.readiness.ach },
    { key: 'positivePay', readiness: settings.readiness.positivePay },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ts.readiness.title}</CardTitle>
        <CardDescription>{ts.readiness.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3 text-sm">
          {rows.map(({ key, readiness }) => (
            <li key={key} className="flex flex-wrap items-start gap-3">
              <span className="w-32 font-medium">{ts.readiness[key]}</span>
              {readiness.ready ? (
                <Badge variant="success">{ts.readiness.ready}</Badge>
              ) : (
                <div className="space-y-1">
                  <Badge variant="warning">{ts.readiness.incomplete}</Badge>
                  <ul className="list-disc pl-4 text-muted-foreground">
                    {readiness.missing.map((code) => (
                      <li key={code}>{labels[code] ?? code}</li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Checks

interface CheckSectionProps {
  form: Form;
  settings: BankPaymentSettings;
  canEdit: boolean;
  printing: boolean;
  onPrintTest: () => void;
}

export function CheckSection({ form, settings, canEdit, printing, onPrintTest }: Readonly<CheckSectionProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.payments.settings.checks;
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = form;
  const printMicr = watch('printMicr');
  const layoutId = watch('layout') as CheckLayoutId;
  const layout = settings.layouts.find((l) => l.id === layoutId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tc.title}</CardTitle>
        <CardDescription>{tc.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="next-check-number"
            label={tc.nextCheckNumber}
            hint={
              settings.highestCheckNumberUsed === null
                ? tc.nextCheckNumberHint
                : tc.nextCheckNumberUsed.replace('{number}', String(settings.highestCheckNumberUsed))
            }
            error={errors.nextCheckNumber?.message}
          >
            <Input id="next-check-number" inputMode="numeric" disabled={!canEdit} {...register('nextCheckNumber')} />
          </Field>

          <Field id="check-layout" label={tc.layout} hint={layout?.description}>
            <Controller
              control={control}
              name="layout"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={!canEdit}>
                  <SelectTrigger id="check-layout">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {settings.layouts.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{tc.layouts[l.id]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        </div>

        <Controller
          control={control}
          name="printMicr"
          render={({ field }) => (
            <ToggleRow
              id="check-print-micr"
              label={tc.blankStock}
              hint={tc.blankStockHint}
              checked={field.value}
              onChange={canEdit ? field.onChange : () => undefined}
            />
          )}
        />

        {printMicr ? (
          <Alert>
            <AlertTriangle />
            <AlertTitle>{tc.micrNotice.title}</AlertTitle>
            <AlertDescription>
              <p>{tc.micrNotice.body}</p>
              <p className="mt-1">{tc.micrNotice.action}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {printMicr ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="check-bank-name" label={tc.bankName} error={errors.bankName?.message}>
                <Input id="check-bank-name" disabled={!canEdit} {...register('bankName')} />
              </Field>
              <Field id="check-fractional" label={tc.fractional} hint={tc.fractionalHint} error={errors.fractionalNumerator?.message}>
                <Input id="check-fractional" placeholder="90-7162" disabled={!canEdit} {...register('fractionalNumerator')} />
              </Field>
              <Field id="check-bank-address" label={tc.bankAddress} hint={tc.bankAddressHint} error={errors.bankAddress?.message}>
                <Textarea id="check-bank-address" rows={3} disabled={!canEdit} {...register('bankAddress')} />
              </Field>
              <Field id="check-signature" label={tc.signatureText} hint={tc.signatureTextHint} error={errors.signatureLineText?.message}>
                <Input id="check-signature" disabled={!canEdit} {...register('signatureLineText')} />
              </Field>
              <Field id="check-micr-layout" label={tc.micrLayout} hint={tc.micrLayoutHint}>
                <Controller
                  control={control}
                  name="micrLayout"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={!canEdit}>
                      <SelectTrigger id="check-micr-layout">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="business">{tc.micrBusiness}</SelectItem>
                        <SelectItem value="personal">{tc.micrPersonal}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <Field id="check-number-width" label={tc.numberWidth} hint={tc.numberWidthHint} error={errors.checkNumberWidth?.message}>
                <Input id="check-number-width" inputMode="numeric" disabled={!canEdit} {...register('checkNumberWidth')} />
              </Field>
            </div>
            {!settings.hasAccountNumber || !settings.routingNumber ? (
              <p className="text-sm text-muted-foreground">{tc.micrNeedsAccount}</p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{tc.alignmentTitle}</h3>
            <p className="text-xs text-muted-foreground">{tc.alignmentHint}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="align-dx" label={tc.alignmentDx} error={errors.dx?.message}>
              <Input id="align-dx" inputMode="decimal" disabled={!canEdit} {...register('dx')} />
            </Field>
            <Field id="align-dy" label={tc.alignmentDy} error={errors.dy?.message}>
              <Input id="align-dy" inputMode="decimal" disabled={!canEdit} {...register('dy')} />
            </Field>
            <Field id="align-micr-dx" label={tc.alignmentMicrDx} error={errors.micrDx?.message}>
              <Input id="align-micr-dx" inputMode="decimal" disabled={!canEdit} {...register('micrDx')} />
            </Field>
            <Field id="align-micr-dy" label={tc.alignmentMicrDy} error={errors.micrDy?.message}>
              <Input id="align-micr-dy" inputMode="decimal" disabled={!canEdit} {...register('micrDy')} />
            </Field>
          </div>
          <Button type="button" variant="outline" onClick={onPrintTest} disabled={printing}>
            <Printer className="h-4 w-4" aria-hidden />
            {tc.printTest}
          </Button>
          <p className="text-xs text-muted-foreground">{tc.printTestHint}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ACH

interface AchSectionProps {
  form: Form;
  settings: BankPaymentSettings;
  accounts: readonly UsBankAccount[];
  canEdit: boolean;
}

export function AchSection({ form, settings, accounts, canEdit }: Readonly<AchSectionProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const ta = tp.settings.ach;
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = form;
  const balanced = watch('balanced');
  const effective = settings.effectiveAch;
  const hasCompanyId = !!effective.companyIdentification;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ta.title}</CardTitle>
        <CardDescription>{ta.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-md border bg-muted/30 p-3">
          <h3 className="text-sm font-medium">{ta.effectiveTitle}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{ta.effectiveHint}</p>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{ta.effective.destination}</dt>
              <dd className="font-medium">{effective.immediateDestination ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{ta.effective.destinationName}</dt>
              <dd className="font-medium">{effective.immediateDestinationName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{ta.effective.origin}</dt>
              <dd className="font-medium">{effective.immediateOrigin ? maskedCompanyId(effective.immediateOrigin) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{ta.effective.originName}</dt>
              <dd className="font-medium">{effective.immediateOriginName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{ta.effective.companyName}</dt>
              <dd className="font-medium">{effective.companyName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{ta.effective.companyId}</dt>
              <dd className="font-medium">{maskedCompanyId(effective.companyIdentification)}</dd>
            </div>
          </dl>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ach-destination" label={ta.destination} hint={ta.destinationHint} error={errors.immediateDestination?.message}>
            <Input id="ach-destination" inputMode="numeric" disabled={!canEdit} {...register('immediateDestination')} />
          </Field>
          <Field id="ach-destination-name" label={ta.destinationName} error={errors.immediateDestinationName?.message}>
            <Input id="ach-destination-name" disabled={!canEdit} {...register('immediateDestinationName')} />
          </Field>
          <Field id="ach-origin" label={ta.origin} hint={ta.originHint} error={errors.immediateOrigin?.message}>
            <Input id="ach-origin" disabled={!canEdit} {...register('immediateOrigin')} />
          </Field>
          <Field id="ach-origin-name" label={ta.originName} error={errors.immediateOriginName?.message}>
            <Input id="ach-origin-name" disabled={!canEdit} {...register('immediateOriginName')} />
          </Field>
          <Field id="ach-company-name" label={ta.companyName} hint={ta.companyNameHint} error={errors.companyName?.message}>
            <Input id="ach-company-name" maxLength={16} disabled={!canEdit} {...register('companyName')} />
          </Field>
          <Field id="ach-ein" label={ta.ein} hint={hasCompanyId ? ta.einReplaceHint : ta.einHint} error={errors.ein?.message}>
            <Input id="ach-ein" autoComplete="off" placeholder={hasCompanyId ? '••-•••••••' : '12-3456789'} disabled={!canEdit} {...register('ein')} />
          </Field>
          <Field id="ach-odfi" label={ta.odfi} hint={ta.odfiHint} error={errors.odfiRoutingNumber?.message}>
            <Input id="ach-odfi" inputMode="numeric" disabled={!canEdit} {...register('odfiRoutingNumber')} />
          </Field>
          <Field id="ach-entry-description" label={ta.entryDescription} hint={ta.entryDescriptionHint} error={errors.entryDescription?.message}>
            <Input id="ach-entry-description" maxLength={10} placeholder="VENDOR PAY" disabled={!canEdit} {...register('entryDescription')} />
          </Field>
          <Field id="ach-sec" label={ta.defaultSecCode} hint={ta.defaultSecCodeHint}>
            <Controller
              control={control}
              name="defaultSecCode"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={!canEdit}>
                  <SelectTrigger id="ach-sec">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACH_SEC_CODES.map((code) => (
                      <SelectItem key={code} value={code}>{tp.secCodes[code]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field id="ach-hold-window" label={ta.holdWindow} hint={ta.holdWindowHint} error={errors.holdWindowDays?.message}>
            <Input id="ach-hold-window" inputMode="numeric" disabled={!canEdit} {...register('holdWindowDays')} />
          </Field>
        </div>

        <div className="space-y-3">
          <Controller
            control={control}
            name="balanced"
            render={({ field }) => (
              <ToggleRow id="ach-balanced" label={ta.balanced} hint={ta.balancedHint} checked={field.value} onChange={canEdit ? field.onChange : () => undefined} />
            )}
          />
          {balanced ? (
            <Field id="ach-offset" label={ta.offsetAccount} hint={ta.offsetAccountHint}>
              <Controller
                control={control}
                name="offsetBankAccountId"
                render={({ field }) => (
                  <Select value={field.value || 'same'} onValueChange={(value) => field.onChange(value === 'same' ? '' : value)} disabled={!canEdit}>
                    <SelectTrigger id="ach-offset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="same">{ta.offsetSame}</SelectItem>
                      {accounts
                        .filter((a) => a.id !== settings.bankAccountId)
                        .map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          ) : null}
          <Controller
            control={control}
            name="sameDayAllowed"
            render={({ field }) => (
              <ToggleRow id="ach-same-day" label={ta.sameDay} hint={ta.sameDayHint} checked={field.value} onChange={canEdit ? field.onChange : () => undefined} />
            )}
          />
          <Controller
            control={control}
            name="requirePrenotes"
            render={({ field }) => (
              <ToggleRow id="ach-prenotes" label={ta.prenotes} hint={ta.prenotesHint} checked={field.value} onChange={canEdit ? field.onChange : () => undefined} />
            )}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Positive Pay

export function PositivePaySection({ form, settings, canEdit }: Readonly<{ form: Form; settings: BankPaymentSettings; canEdit: boolean }>) {
  const { t } = useI18n();
  const tpp = t.weldbooksUs.payments.settings.positivePay;
  const { control, watch } = form;
  const formatId = watch('positivePayFormat');
  const format = settings.positivePayFormats.find((f) => f.id === formatId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tpp.title}</CardTitle>
        <CardDescription>{tpp.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field id="pp-format-setting" label={tpp.format}>
          <Controller
            control={control}
            name="positivePayFormat"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={!canEdit}>
                <SelectTrigger id="pp-format-setting">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {settings.positivePayFormats.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>
        {format ? <p className="text-sm text-muted-foreground">{format.note}</p> : null}
        {format?.needsBankSpec ? (
          <Alert>
            <AlertTriangle />
            <AlertTitle>{tpp.templateTitle}</AlertTitle>
            <AlertDescription>{tpp.templateBody}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
