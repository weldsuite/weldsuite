import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Loader2, Lock } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SecretInput } from '@/app/weldbooks/customers/components/secret-input';
import { US_STATES } from '@/components/address/us-states';
import { PublicW9Error, publicW9Api } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { formatTinInput, tinPlaceholder } from '@/lib/weldbooks/vendor-tin';
import {
  EMPTY_W9_VALUES,
  W9_PAGE_CLASSIFICATIONS,
  W9_PAGE_LLC_CLASSIFICATIONS,
  W9_TIN_TYPES,
  buildW9Submission,
  createW9Schema,
  serverFieldToFormField,
  type W9FormValues,
} from './w9-form-model';

/** Keeps the link and the page out of search engines and out of referrer headers. */
function useQuietPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Form W-9';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      document.title = previousTitle;
      robots.remove();
      referrer.remove();
    };
  }, []);
}

function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-muted/30 px-4 py-8 text-foreground sm:py-12">
      <main className="mx-auto w-full max-w-2xl space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" aria-hidden />
          <span>{t.weldbooksUs.form1099.publicW9.secure}</span>
        </div>
        {children}
      </main>
    </div>
  );
}

function Panel({ children, title, hint }: Readonly<{ children: React.ReactNode; title: string; hint?: string }>) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4 text-card-foreground shadow-xs sm:p-6">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function FieldError({ message }: Readonly<{ message?: string }>) {
  return message ? (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  ) : null;
}

/**
 * The page a vendor opens from the link they were sent: IRS Form W-9 (Rev.
 * March 2024) filled in online. No sign-in; the token in the link is the
 * credential. It shows who asked, takes the form, and says thank you. A link
 * that is unknown, expired, used or cancelled shows the same "not available"
 * page, so nothing about the request leaks.
 */
export default function PublicW9Page() {
  const { token } = useParams({ strict: false }) as { token: string };
  const { t, language } = useI18n();
  const tp = t.weldbooksUs.form1099.publicW9;
  useQuietPage();

  const request = useQuery({
    queryKey: ['public-w9', token],
    queryFn: () => publicW9Api.load(token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  const schema = useMemo(() => createW9Schema(tp.errors), [tp.errors]);
  const form = useForm<W9FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY_W9_VALUES });
  const [done, setDone] = useState(false);
  const [expired, setExpired] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: (values: W9FormValues) => publicW9Api.submit(token, buildW9Submission(values)),
    onSuccess: () => {
      form.reset(EMPTY_W9_VALUES);
      setDone(true);
    },
    onError: (err) => {
      if (err instanceof PublicW9Error) {
        if (err.isNotFound) {
          setExpired(true);
          return;
        }
        let mapped = false;
        for (const [path, messages] of Object.entries(err.fieldErrors)) {
          const field = serverFieldToFormField(path);
          if (field && messages[0]) {
            form.setError(field, { message: messages[0] });
            mapped = true;
          }
        }
        setFormError(mapped ? tp.checkFields : err.status === 413 || err.status >= 500 ? tp.tryAgain : err.message);
        return;
      }
      setFormError(tp.tryAgain);
    },
  });

  const classification = form.watch('classification');
  const tinType = form.watch('tinType');
  const subjectToBackup = form.watch('subjectToBackupWithholding');
  const errors = form.formState.errors;

  if (request.isLoading) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          {tp.loading}
        </div>
      </Shell>
    );
  }

  const notAvailable = expired || (request.isError && request.error instanceof PublicW9Error && request.error.isNotFound);
  if (notAvailable) {
    return (
      <Shell>
        <div className="space-y-3 rounded-lg border bg-card p-6 text-center" data-testid="w9-not-available">
          <AlertCircle className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <h1 className="text-lg font-semibold">{tp.notAvailableTitle}</h1>
          <p className="text-sm text-muted-foreground">{tp.notAvailable}</p>
        </div>
      </Shell>
    );
  }

  if (request.isError || !request.data) {
    return (
      <Shell>
        <div className="space-y-3 rounded-lg border bg-card p-6 text-center" role="alert">
          <AlertCircle className="mx-auto h-8 w-8 text-destructive" aria-hidden />
          <h1 className="text-lg font-semibold">{tp.loadFailedTitle}</h1>
          <p className="text-sm text-muted-foreground">{tp.loadFailed}</p>
          <Button variant="outline" onClick={() => void request.refetch()}>
            {tp.retry}
          </Button>
        </div>
      </Shell>
    );
  }

  const { payer, vendor, expiresAt } = request.data;

  if (done) {
    return (
      <Shell>
        <div className="space-y-3 rounded-lg border bg-card p-6 text-center" data-testid="w9-done">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" aria-hidden />
          <h1 className="text-xl font-semibold">{tp.doneTitle}</h1>
          <p className="text-sm text-muted-foreground">{tp.done.replace('{payer}', payer.name || tp.thePayer)}</p>
          <p className="text-xs text-muted-foreground">{tp.doneClose}</p>
        </div>
      </Shell>
    );
  }

  const expiresOn = new Date(expiresAt).toLocaleDateString(language || 'en', { dateStyle: 'long' });

  return (
    <Shell>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{tp.title}</h1>
        <p className="text-sm text-muted-foreground">{tp.subtitle}</p>
        <p className="pt-2 text-sm">
          {tp.requestedBy.replace('{payer}', payer.name || tp.thePayer)}
          {vendor.displayName ? <span className="text-muted-foreground"> {tp.forVendor.replace('{vendor}', vendor.displayName)}</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">{tp.expires.replace('{date}', expiresOn)}</p>
      </header>

      <form
        noValidate
        className="space-y-6"
        onSubmit={form.handleSubmit((values) => {
          setFormError(null);
          submit.mutate(values);
        })}
      >
        <Panel title={tp.identityTitle} hint={tp.identityHint}>
          <div className="space-y-2">
            <Label htmlFor="w9-legal-name">{tp.legalName} *</Label>
            <Input id="w9-legal-name" autoComplete="name" maxLength={100} aria-invalid={Boolean(errors.legalName)} {...form.register('legalName')} />
            <p className="text-xs text-muted-foreground">{tp.legalNameHelp}</p>
            <FieldError message={errors.legalName?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="w9-business-name">{tp.businessName}</Label>
            <Input id="w9-business-name" autoComplete="organization" maxLength={100} {...form.register('businessName')} />
            <p className="text-xs text-muted-foreground">{tp.businessNameHelp}</p>
          </div>
        </Panel>

        <Panel title={tp.classificationTitle} hint={tp.classificationHint}>
          <Controller
            control={form.control}
            name="classification"
            render={({ field }) => (
              <RadioGroup
                value={field.value}
                onValueChange={field.onChange}
                aria-label={tp.classificationTitle}
                aria-invalid={Boolean(errors.classification)}
              >
                {W9_PAGE_CLASSIFICATIONS.map((value) => (
                  <label key={value} htmlFor={`w9-class-${value}`} className="flex items-start gap-2 text-sm">
                    <RadioGroupItem id={`w9-class-${value}`} value={value} className="mt-0.5" />
                    <span>
                      <span className="font-medium">{tp.classifications[value]}</span>
                      <span className="block text-xs text-muted-foreground">{tp.classificationHelp[value]}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
          />
          <FieldError message={errors.classification?.message} />
          {classification === 'llc' ? (
            <div className="space-y-2">
              <Label htmlFor="w9-llc">{tp.llcClassification} *</Label>
              <Controller
                control={form.control}
                name="llcClassification"
                render={({ field }) => (
                  <Select value={field.value || '__none__'} onValueChange={(value) => field.onChange(value === '__none__' ? '' : value)}>
                    <SelectTrigger id="w9-llc" aria-invalid={Boolean(errors.llcClassification)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{tp.choose}</SelectItem>
                      {W9_PAGE_LLC_CLASSIFICATIONS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {tp.llcOptions[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError message={errors.llcClassification?.message} />
            </div>
          ) : null}
        </Panel>

        <Panel title={tp.exemptionsTitle} hint={tp.exemptionsHint}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="w9-exempt">{tp.exemptPayeeCode}</Label>
              <Input id="w9-exempt" maxLength={2} autoComplete="off" className="uppercase" {...form.register('exemptPayeeCode')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="w9-fatca">{tp.fatcaCode}</Label>
              <Input id="w9-fatca" maxLength={2} autoComplete="off" className="uppercase" {...form.register('fatcaCode')} />
            </div>
          </div>
        </Panel>

        <Panel title={tp.addressTitle}>
          <div className="space-y-2">
            <Label htmlFor="w9-line1">{tp.line1} *</Label>
            <Input id="w9-line1" autoComplete="address-line1" maxLength={100} aria-invalid={Boolean(errors.line1)} {...form.register('line1')} />
            <FieldError message={errors.line1?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="w9-line2">{tp.line2}</Label>
            <Input id="w9-line2" autoComplete="address-line2" maxLength={100} {...form.register('line2')} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <div className="space-y-2 sm:col-span-3">
              <Label htmlFor="w9-city">{tp.city} *</Label>
              <Input id="w9-city" autoComplete="address-level2" maxLength={60} aria-invalid={Boolean(errors.city)} {...form.register('city')} />
              <FieldError message={errors.city?.message} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="w9-state">{tp.state} *</Label>
              <Controller
                control={form.control}
                name="state"
                render={({ field }) => (
                  <Select value={field.value || '__none__'} onValueChange={(value) => field.onChange(value === '__none__' ? '' : value)}>
                    <SelectTrigger id="w9-state" aria-invalid={Boolean(errors.state)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{tp.choose}</SelectItem>
                      {US_STATES.map((state) => (
                        <SelectItem key={state.code} value={state.code}>
                          {state.code} · {state.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError message={errors.state?.message} />
            </div>
            <div className="space-y-2 sm:col-span-1">
              <Label htmlFor="w9-zip">{tp.zip} *</Label>
              <Input
                id="w9-zip"
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={10}
                aria-invalid={Boolean(errors.postalCode)}
                {...form.register('postalCode')}
              />
              <FieldError message={errors.postalCode?.message} />
            </div>
          </div>
        </Panel>

        <Panel title={tp.tinTitle} hint={tp.tinHint}>
          <Controller
            control={form.control}
            name="tinType"
            render={({ field }) => (
              <RadioGroup
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value);
                  const current = form.getValues('tin');
                  if (current && (value === 'ein' || value === 'ssn' || value === 'itin')) form.setValue('tin', formatTinInput(value, current));
                }}
                className="grid-cols-1 gap-2 sm:grid-cols-3"
                aria-label={tp.tinType}
              >
                {W9_TIN_TYPES.map((value) => (
                  <label key={value} htmlFor={`w9-tin-${value}`} className="flex items-start gap-2 rounded-md border p-3 text-sm">
                    <RadioGroupItem id={`w9-tin-${value}`} value={value} className="mt-0.5" />
                    <span>
                      <span className="font-medium">{tp.tinTypes[value]}</span>
                      <span className="block text-xs text-muted-foreground">{tp.tinTypeHelp[value]}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
          />
          <FieldError message={errors.tinType?.message} />
          <div className="space-y-2">
            <Label htmlFor="w9-tin">{tp.tin} *</Label>
            <Controller
              control={form.control}
              name="tin"
              render={({ field }) => (
                <SecretInput
                  id="w9-tin"
                  value={field.value}
                  placeholder={tinPlaceholder(tinType)}
                  showLabel={tp.showTin}
                  hideLabel={tp.hideTin}
                  aria-describedby="w9-tin-help"
                  aria-invalid={Boolean(errors.tin)}
                  onChange={(value) => field.onChange(tinType ? formatTinInput(tinType, value) : value)}
                />
              )}
            />
            <p id="w9-tin-help" className="text-xs text-muted-foreground">
              {tp.tinHelp}
            </p>
            <FieldError message={errors.tin?.message} />
          </div>
        </Panel>

        <Panel title={tp.certificationTitle}>
          <p className="text-sm font-medium">{tp.certificationIntro}</p>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {tp.certificationItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">{tp.certificationNote}</p>

          <Controller
            control={form.control}
            name="subjectToBackupWithholding"
            render={({ field }) => (
              <label className="flex items-start gap-2 text-sm" htmlFor="w9-backup">
                <Checkbox id="w9-backup" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                <span>{tp.subjectToBackup}</span>
              </label>
            )}
          />
          {subjectToBackup ? (
            <Alert variant="destructive">
              <AlertTitle>{tp.subjectToBackupTitle}</AlertTitle>
              <AlertDescription>{tp.subjectToBackupHelp.replace('{payer}', payer.name || tp.thePayer)}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="w9-signature">{tp.signature} *</Label>
            <Input
              id="w9-signature"
              autoComplete="off"
              maxLength={100}
              aria-describedby="w9-signature-help"
              aria-invalid={Boolean(errors.signedName)}
              {...form.register('signedName')}
            />
            <p id="w9-signature-help" className="text-xs text-muted-foreground">
              {tp.signatureHelp}
            </p>
            <FieldError message={errors.signedName?.message} />
          </div>

          <Controller
            control={form.control}
            name="certify"
            render={({ field }) => (
              <div className="space-y-1">
                <label className="flex items-start gap-2 text-sm" htmlFor="w9-certify">
                  <Checkbox id="w9-certify" checked={field.value} aria-invalid={Boolean(errors.certify)} onCheckedChange={(checked) => field.onChange(checked === true)} />
                  <span>{tp.certify}</span>
                </label>
                <FieldError message={errors.certify?.message} />
              </div>
            )}
          />
        </Panel>

        {formError ? (
          <Alert variant="destructive" data-testid="w9-form-error">
            <AlertCircle aria-hidden />
            <AlertTitle>{tp.notSubmitted}</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">{tp.privacy}</p>
          <Button type="submit" size="lg" disabled={submit.isPending || subjectToBackup}>
            {submit.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
            {submit.isPending ? tp.submitting : tp.submit}
          </Button>
        </div>
      </form>
    </Shell>
  );
}
