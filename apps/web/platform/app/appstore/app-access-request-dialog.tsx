/**
 * Request access to an app that is on request only (WeldReach).
 *
 * The form follows `workspace_app_access.request`: company details, use case,
 * expected volume, target countries and where the lists come from, plus every
 * term ticked one by one (`WELDREACH_TERMS`, text versioned by
 * `WELDREACH_TERMS_VERSION`). Netherlands and Germany get a consent notice.
 * Copy lives in the `reach.access` i18n section; WeldReach is the only app
 * that asks for access today.
 */

import { useEffect, useMemo } from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { useUser } from '@/lib/auth';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { isApiError } from '@weldsuite/api-client';
import {
  appAccessRequestInputSchema,
  listSourceSchema,
  WELDREACH_CONSENT_COUNTRIES,
  WELDREACH_TERMS,
  WELDREACH_TERMS_VERSION,
  type AppAccessView,
} from '@weldsuite/app-api-client/schemas/reach';
import { useAppAccessRequest, useRequestAppAccess } from '@/hooks/queries/use-app-access-queries';
import { createReachSchemaOptions } from '@/lib/reach/zod-error-map';
import { NumberInput } from '@/components/shared/number-input';
import { CountryMultiSelect } from './country-multi-select';

/** Every term must be ticked, not just one: the contract schema only asks for at least one. */
const requestFormSchema = appAccessRequestInputSchema.refine(
  (value) => WELDREACH_TERMS.every((key) => value.termsAccepted.includes(key)),
  { path: ['termsAccepted'], message: 'terms' },
);
type RequestFormInput = z.input<typeof requestFormSchema>;
type RequestFormOutput = z.output<typeof requestFormSchema>;

const LIST_SOURCES = listSourceSchema.options;

interface AppAccessRequestDialogProps {
  app: { code: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the request was filed. */
  onSubmitted?: () => void;
}

export function AppAccessRequestDialog({ app, open, onOpenChange, onSubmitted }: Readonly<AppAccessRequestDialogProps>) {
  const t = useTranslations();
  const { user } = useUser();
  const requestAccess = useRequestAppAccess(app.code);
  // A rejected or revoked request starts the next one from its answers.
  const existing = useAppAccessRequest(app.code, open);
  const previous: AppAccessView['request'] =
    existing.data?.status === 'rejected' || existing.data?.status === 'revoked' ? existing.data.request : null;
  const schemaOptions = useMemo(() => createReachSchemaOptions(t), [t]);

  // Primitives, not the Clerk user object: the defaults reset the form, so they must only change with the values.
  const userName = user?.fullName ?? '';
  const userEmail = user?.primaryEmailAddress?.emailAddress ?? '';
  const defaults = useMemo<DefaultValues<RequestFormInput>>(
    () => ({
      companyName: previous?.companyName ?? '',
      website: previous?.website ?? '',
      contactName: previous?.contactName ?? userName,
      contactEmail: previous?.contactEmail ?? userEmail,
      useCase: previous?.useCase ?? '',
      expectedDailySends: previous?.expectedDailySends,
      targetCountries: previous?.targetCountries ?? [],
      listSource: previous?.listSource ?? 'own_research',
      listSourceDetails: previous?.listSourceDetails ?? '',
      termsVersion: WELDREACH_TERMS_VERSION,
      termsAccepted: [],
    }),
    [previous, userName, userEmail],
  );

  const form = useForm<RequestFormInput, unknown, RequestFormOutput>({
    resolver: zodResolver(requestFormSchema, schemaOptions),
    defaultValues: defaults,
  });

  // Start fresh (or from the earlier answers) every time the dialog opens.
  useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  const countries = form.watch('targetCountries') ?? [];
  const showConsentNotice = countries.some((code) =>
    (WELDREACH_CONSENT_COUNTRIES as readonly string[]).includes(code.toUpperCase()),
  );
  const termsError = form.formState.errors.termsAccepted;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await requestAccess.mutateAsync({
        ...values,
        termsVersion: WELDREACH_TERMS_VERSION,
        listSourceDetails: values.listSourceDetails?.trim() || undefined,
      });
      toast.success(t('reach.access.submitted'));
      onSubmitted?.();
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        toast.error(t('reach.access.alreadyPending'));
        onOpenChange(false);
        return;
      }
      toast.error(t('reach.accessUi.requestFailed'));
    }
  });

  const submitting = requestAccess.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      {/*
        Header and footer stay put and only the body scrolls, so the form never
        runs past the dialog and Send is always in reach.
      */}
      <DialogContent className="flex max-h-[min(90vh,56rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-6 pt-6 pb-4">
          <DialogTitle>{t('reach.access.requestTitle')}</DialogTitle>
          <DialogDescription>{t('reach.access.requestIntro')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-6 py-5">
              {previous && <p className="text-sm text-muted-foreground">{t('reach.accessUi.previousRequest')}</p>}

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="companyName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('reach.access.form.companyName')}</FormLabel>
                      <FormControl>
                        <Input autoComplete="organization" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="website"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('reach.access.form.website')}</FormLabel>
                      <FormControl>
                        <Input autoComplete="url" placeholder="https://" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="contactName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('reach.access.form.contactName')}</FormLabel>
                      <FormControl>
                        <Input autoComplete="name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="contactEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('reach.access.form.contactEmail')}</FormLabel>
                      <FormControl>
                        <Input type="email" autoComplete="email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="useCase"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('reach.access.form.useCase')}</FormLabel>
                    <FormControl>
                      <Textarea rows={4} placeholder={t('reach.access.form.useCasePlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid items-start gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="expectedDailySends"
                  render={({ field }) => (
                    <FormItem className="min-w-0 grid-cols-[minmax(0,1fr)]">
                      <FormLabel>{t('reach.access.form.expectedDailySends')}</FormLabel>
                      <FormControl>
                        <NumberInput
                          min={1}
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          value={field.value}
                          onValueChange={field.onChange}
                        />
                      </FormControl>
                      <FormDescription>{t('reach.accessUi.expectedDailySendsHint')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="listSource"
                  render={({ field }) => (
                    <FormItem className="min-w-0 grid-cols-[minmax(0,1fr)]">
                      <FormLabel>{t('reach.access.form.listSource')}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {LIST_SOURCES.map((source) => (
                            <SelectItem key={source} value={source}>
                              {t(`reach.access.form.listSources.${source}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="listSourceDetails"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('reach.access.form.listSourceDetails')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={2}
                        placeholder={t('reach.accessUi.listSourceDetailsPlaceholder')}
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="targetCountries"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('reach.access.form.targetCountries')}</FormLabel>
                    <FormControl>
                      <CountryMultiSelect
                        value={field.value}
                        onChange={field.onChange}
                        placeholder={t('reach.access.form.targetCountriesPlaceholder')}
                        invalid={!!form.formState.errors.targetCountries}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {showConsentNotice && (
                <InfoBanner variant="warning">{t('reach.access.form.consentNotice')}</InfoBanner>
              )}

              <FormField
                control={form.control}
                name="termsAccepted"
                render={({ field }) => (
                  <FormItem className="gap-0 overflow-hidden rounded-lg border">
                    <div className="flex items-start justify-between gap-4 border-b bg-muted/40 px-4 py-3">
                      <div className="space-y-1">
                        <p className="text-sm font-medium">{t('reach.access.form.termsTitle')}</p>
                        <p className="text-sm text-muted-foreground">{t('reach.access.form.termsIntro')}</p>
                      </div>
                      <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                        {t('reach.accessUi.termsProgress', {
                          count: WELDREACH_TERMS.filter((key) => field.value.includes(key)).length,
                          total: WELDREACH_TERMS.length,
                        })}
                      </span>
                    </div>
                    <div className="divide-y">
                      {WELDREACH_TERMS.map((key) => {
                        const checkboxId = `reach-term-${key}`;
                        return (
                          <div key={key} className="flex items-start gap-3 px-4 py-3">
                            <Checkbox
                              id={checkboxId}
                              className="mt-0.5"
                              checked={field.value.includes(key)}
                              onCheckedChange={(checked) =>
                                field.onChange(
                                  checked === true
                                    ? [...field.value.filter((value) => value !== key), key]
                                    : field.value.filter((value) => value !== key),
                                )
                              }
                            />
                            <Label htmlFor={checkboxId} className="cursor-pointer text-sm font-normal leading-snug">
                              {t(`reach.access.terms.${key}`)}
                            </Label>
                          </div>
                        );
                      })}
                    </div>
                    {termsError && (
                      <p className="border-t px-4 py-3 text-sm text-destructive">{t('reach.accessUi.termsRequired')}</p>
                    )}
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="shrink-0 border-t px-6 py-4">
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {submitting ? t('reach.access.form.submitting') : t('reach.access.form.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
