/**
 * Partner settings: the contact details customers see in their billing page,
 * on the territory screen and when they ask for an app.
 */

import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { partnerSettingsSchema } from '@weldsuite/app-api-client/schemas/partners';
import { usePartnerSettings, useUpdatePartnerSettings } from '@/hooks/queries/use-partner-queries';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerContext } from '@/lib/partner/partner-context';
import { safeHttpUrl } from '@/lib/partner/safe-url';
import { ErrorBlock, FieldMessage, LoadingBlock, PageHeader, errorText } from './components/kit';

const optionalUrl = z.union([
  z.literal(''),
  z.string().trim().url().max(500).refine((v) => safeHttpUrl(v) !== null),
]);
const formSchema = z.object({
  websiteUrl: optionalUrl,
  supportEmail: z.union([z.literal(''), z.string().trim().email().max(255)]),
  supportUrl: optionalUrl,
  logoUrl: optionalUrl,
});
type FormValues = z.infer<typeof formSchema>;

const EMPTY: FormValues = { websiteUrl: '', supportEmail: '', supportUrl: '', logoUrl: '' };

export default function PartnerSettingsPage() {
  const { t } = useI18n();
  const ts = t.partner.settings;
  const { can, membership } = usePartnerContext();
  const canEdit = can('partner:team:manage');
  const { data, isLoading, error, refetch } = usePartnerSettings();
  const update = useUpdatePartnerSettings();

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: EMPTY });

  useEffect(() => {
    if (!data) return;
    form.reset({
      websiteUrl: data.websiteUrl ?? '',
      supportEmail: data.supportEmail ?? '',
      supportUrl: data.supportUrl ?? '',
      logoUrl: data.logoUrl ?? '',
    });
  }, [data, form]);

  if (isLoading) {
    return (
      <>
        <PageHeader title={ts.title} description={ts.description} />
        <LoadingBlock rows={3} />
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <PageHeader title={ts.title} />
        <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />
      </>
    );
  }

  const errors = form.formState.errors;
  const watched = form.watch();

  const onSubmit = form.handleSubmit(async (values) => {
    const body = partnerSettingsSchema.safeParse({
      websiteUrl: values.websiteUrl || null,
      supportEmail: values.supportEmail || null,
      supportUrl: values.supportUrl || null,
      logoUrl: values.logoUrl || null,
    });
    if (!body.success) return;
    try {
      await update.mutateAsync(body.data);
      toast.success(t.partner.common.saved);
    } catch (err) {
      toast.error(errorText(err, t.partner.common.saveFailed));
    }
  });

  const field = (
    name: keyof FormValues,
    label: string,
    message: string,
    props: { type?: string; placeholder?: string } = {},
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`ps-${name}`}>{label}</Label>
      <Input
        id={`ps-${name}`}
        disabled={!canEdit || update.isPending}
        aria-invalid={Boolean(errors[name])}
        {...props}
        {...form.register(name)}
      />
      {errors[name] && <FieldMessage>{message}</FieldMessage>}
    </div>
  );

  return (
    <>
      <PageHeader title={ts.title} description={ts.description} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ts.companyHeading}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              {field('websiteUrl', ts.websiteUrl, ts.invalidUrl, { type: 'url', placeholder: 'https://' })}
              {field('supportEmail', ts.supportEmail, ts.invalidEmail, { type: 'email' })}
              {field('supportUrl', ts.supportUrl, ts.invalidUrl, { type: 'url', placeholder: 'https://' })}
              {field('logoUrl', ts.logoUrl, ts.invalidUrl, { type: 'url', placeholder: 'https://' })}
              <p className="text-xs text-muted-foreground">{ts.logoHint}</p>
              {canEdit ? (
                <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
                  {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                  {update.isPending ? t.partner.common.saving : t.partner.common.save}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">{ts.readOnlyHint}</p>
              )}
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ts.previewHeading}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-3">
              {safeHttpUrl(watched.logoUrl) ? (
                <img src={safeHttpUrl(watched.logoUrl) ?? undefined} alt="" className="h-10 w-10 rounded-md border object-contain" />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-md border bg-muted text-sm font-semibold">
                  {membership.partnerName.slice(0, 1).toUpperCase()}
                </div>
              )}
              <p className="font-medium">{membership.partnerName}</p>
            </div>
            <ul className="space-y-1 text-muted-foreground">
              {watched.websiteUrl && <li className="truncate">{watched.websiteUrl}</li>}
              {watched.supportEmail && <li className="truncate">{watched.supportEmail}</li>}
              {watched.supportUrl && <li className="truncate">{watched.supportUrl}</li>}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
