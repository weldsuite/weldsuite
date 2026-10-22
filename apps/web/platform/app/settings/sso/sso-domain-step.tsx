import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Globe, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { normalizeSsoDomain, type SsoConfigView } from '@weldsuite/app-api-client/schemas/sso';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useRemoveSsoDomain, useSetSsoDomain, useVerifySsoDomain } from '@/hooks/queries/use-sso-queries';
import { CopyField } from './copy-field';
import { ssoErrorMessage } from './sso-errors';
import { InlineError, StepCard } from './sso-parts';
import { domainIssue, formatSsoDate, type DomainIssue } from './sso-view';

interface DomainFormValues {
  domain: string;
}

interface SsoDomainStepProps {
  config: SsoConfigView;
  canManage: boolean;
}

/** Step 1: claim the company domain and prove it with a DNS TXT record. */
export function SsoDomainStep({ config, canManage }: Readonly<SsoDomainStepProps>) {
  const { t, language, format } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.domain;

  const domain = config.domain;
  const verified = Boolean(domain?.verified);
  // A connection uses the domain: it cannot change or go until the connection does.
  const locked = Boolean(config.connection);

  const setDomain = useSetSsoDomain();
  const removeDomain = useRemoveSsoDomain();
  const verifyDomain = useVerifySsoDomain();

  const [editing, setEditing] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const schema = useMemo(
    () =>
      z.object({
        domain: z.string().superRefine((value, ctx) => {
          const issue = domainIssue(value);
          if (!issue) return;
          const messages: Record<DomainIssue, string> = {
            required: ts.validation.required,
            invalid: ts.errors.domainInvalid,
            public: ts.errors.domainPublic,
          };
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: messages[issue] });
        }),
      }),
    [ts],
  );
  const form = useForm<DomainFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { domain: domain?.name ?? '' },
  });

  // Each time the form opens it starts from what is saved.
  const domainName = domain?.name ?? '';
  useEffect(() => {
    if (editing || !domainName) form.reset({ domain: domainName });
  }, [editing, domainName, form]);

  const showForm = canManage && (!domain || editing);

  const submit = async (values: DomainFormValues) => {
    try {
      // The server normalises as well; sending the bare domain keeps the field and the record in step.
      await setDomain.mutateAsync(normalizeSsoDomain(values.domain) ?? values.domain.trim());
      setEditing(false);
      setError(null);
      toast.success(copy.saved);
    } catch (err) {
      form.setError('domain', { message: ssoErrorMessage(err, ts.errors) });
    }
  };

  const verify = async () => {
    setError(null);
    try {
      await verifyDomain.mutateAsync();
      toast.success(copy.verifiedToast);
    } catch (err) {
      setError(err);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await removeDomain.mutateAsync();
      toast.success(copy.removed);
    } catch (err) {
      setError(err);
    } finally {
      setRemoveOpen(false);
    }
  };

  return (
    <StepCard
      step={1}
      title={copy.title}
      description={copy.description}
      done={verified}
      badge={
        domain ? (
          <Badge variant={verified ? 'success' : 'secondary'}>{verified ? copy.verified : copy.notVerified}</Badge>
        ) : undefined
      }
    >
      {showForm ? (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-3">
            <FormField
              control={form.control}
              name="domain"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{copy.label}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={copy.placeholder}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      className="max-w-sm"
                    />
                  </FormControl>
                  <FormDescription>{copy.hint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={setDomain.isPending}>
                {setDomain.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {copy.save}
              </Button>
              {domain && (
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>
                  {t.common.actions.cancel}
                </Button>
              )}
            </div>
          </form>
        </Form>
      ) : null}

      {!showForm && !domain && <p className="text-sm text-muted-foreground">{copy.none}</p>}

      {!showForm && domain && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="break-all font-medium">{domain.name}</span>
            </div>
            {canManage && (
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setEditing(true)}>
                  {copy.change}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setRemoveOpen(true)}>
                  {copy.remove}
                </Button>
              </div>
            )}
          </div>
          {locked && canManage && <p className="text-sm text-muted-foreground">{copy.lockedHint}</p>}

          {verified ? (
            domain.verifiedAt && (
              <p className="text-sm text-muted-foreground">
                {format(copy.verifiedOn, { date: formatSsoDate(domain.verifiedAt, language) })}
              </p>
            )
          ) : (
            <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">{copy.dnsTitle}</p>
                <p className="text-sm text-muted-foreground">{format(copy.dnsDescription, { domain: domain.name })}</p>
              </div>
              <div className="grid gap-3">
                <CopyField label={copy.recordType} value={domain.dnsRecord.type} />
                <CopyField label={copy.recordName} value={domain.dnsRecord.name} />
                <CopyField label={copy.recordValue} value={domain.dnsRecord.value} />
              </div>
              {canManage && (
                <Button type="button" size="sm" disabled={verifyDomain.isPending} onClick={() => void verify()}>
                  {verifyDomain.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {copy.verify}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors)}</InlineError>}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={copy.removeConfirmTitle}
        description={format(copy.removeConfirmDescription, { domain: domain?.name ?? '' })}
        confirmLabel={copy.remove}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={remove}
      />
    </StepCard>
  );
}
