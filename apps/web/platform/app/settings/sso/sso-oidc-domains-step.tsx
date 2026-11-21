import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Globe, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Input } from '@weldsuite/ui/components/input';
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
import {
  normalizeSsoDomain,
  type SsoDomainStatus,
  type SsoOidcDomainView,
  type SsoOidcView,
} from '@weldsuite/app-api-client/schemas/sso';
import { useI18n } from '@/lib/i18n/provider';
import {
  useAddSsoConnectionDomain,
  useRemoveSsoConnectionDomain,
  useVerifySsoConnectionDomain,
} from '@/hooks/queries/use-sso-queries';
import { CopyField } from './copy-field';
import { ssoErrorMessage } from './sso-errors';
import { InlineError, StepCard } from './sso-parts';
import { domainIssue, formatSsoDate, type DomainIssue } from './sso-view';

const STATUS_BADGE: Record<SsoDomainStatus, 'success' | 'secondary' | 'warning'> = {
  verified: 'success',
  pending: 'secondary',
  failed: 'warning',
};

interface DomainFormValues {
  domain: string;
}

interface SsoOidcDomainsStepProps {
  oidc: SsoOidcView;
  canManage: boolean;
}

/**
 * WeldID mode, step 2: the connection's domains, each proven with a TXT
 * record that WeldID looks for when asked (it acts on the result).
 */
export function SsoOidcDomainsStep({ oidc, canManage }: Readonly<SsoOidcDomainsStepProps>) {
  const { t, format } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.weldid.domains;

  const add = useAddSsoConnectionDomain();
  const remove = useRemoveSsoConnectionDomain();
  const verify = useVerifySsoConnectionDomain();
  const [removing, setRemoving] = useState<string | null>(null);
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
  const form = useForm<DomainFormValues>({ resolver: zodResolver(schema), defaultValues: { domain: '' } });

  const header = { step: 2, title: copy.title, description: copy.description } as const;
  const anyVerified = oidc.domains.some((domain) => domain.verified);

  if (!oidc.connection) {
    return (
      <StepCard {...header}>
        <InfoBanner variant="neutral">{copy.needsConnection}</InfoBanner>
      </StepCard>
    );
  }

  const submit = async (values: DomainFormValues) => {
    setError(null);
    try {
      await add.mutateAsync(normalizeSsoDomain(values.domain) ?? values.domain.trim());
      form.reset({ domain: '' });
      toast.success(copy.added);
    } catch (err) {
      form.setError('domain', { message: ssoErrorMessage(err, ts.errors, true) });
    }
  };

  const runVerify = async (domain: string) => {
    setError(null);
    try {
      await verify.mutateAsync(domain);
      toast.success(copy.verified);
    } catch (err) {
      setError(err);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setError(null);
    try {
      await remove.mutateAsync(removing);
      toast.success(copy.removed);
    } catch (err) {
      setError(err);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <StepCard
      {...header}
      done={anyVerified}
      badge={anyVerified ? <Badge variant="success">{copy.status.verified}</Badge> : undefined}
    >
      {oidc.domains.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.none}</p>
      ) : (
        <ul className="space-y-3">
          {oidc.domains.map((domain) => (
            <DomainRow
              key={domain.name}
              domain={domain}
              canManage={canManage}
              verifying={verify.isPending && verify.variables === domain.name}
              onVerify={() => void runVerify(domain.name)}
              onRemove={() => setRemoving(domain.name)}
            />
          ))}
        </ul>
      )}

      {canManage && (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-3">
            <FormField
              control={form.control}
              name="domain"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{copy.label}</FormLabel>
                  <div className="flex max-w-md items-start gap-2">
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={copy.placeholder}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                    </FormControl>
                    <Button type="submit" size="sm" variant="outline" className="h-9 shrink-0" disabled={add.isPending}>
                      {add.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {copy.add}
                    </Button>
                  </div>
                  <FormDescription>{copy.hint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
      )}

      {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors, true)}</InlineError>}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={format(copy.removeConfirmTitle, { domain: removing ?? '' })}
        description={format(copy.removeConfirmDescription, { domain: removing ?? '' })}
        confirmLabel={copy.remove}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={confirmRemove}
      />
    </StepCard>
  );
}

interface DomainRowProps {
  domain: SsoOidcDomainView;
  canManage: boolean;
  verifying: boolean;
  onVerify: () => void;
  onRemove: () => void;
}

/** One domain: its status, and until it is verified the record to publish. */
function DomainRow({ domain, canManage, verifying, onVerify, onRemove }: Readonly<DomainRowProps>) {
  const { t, language, format } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.weldid.domains;

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="break-all font-medium">{domain.name}</span>
          <Badge variant={STATUS_BADGE[domain.status]}>{copy.status[domain.status]}</Badge>
        </div>
        {canManage && (
          <div className="flex gap-2">
            {!domain.verified && (
              <Button type="button" size="sm" disabled={verifying} onClick={onVerify}>
                {verifying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {copy.verify}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRemove}
              aria-label={format(copy.removeLabel, { domain: domain.name })}
            >
              {copy.remove}
            </Button>
          </div>
        )}
      </div>

      {domain.verified ? (
        domain.verifiedAt && (
          <p className="text-sm text-muted-foreground">
            {format(ts.domain.verifiedOn, { date: formatSsoDate(domain.verifiedAt, language) })}
          </p>
        )
      ) : (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <p className="text-sm text-muted-foreground">{format(copy.dnsDescription, { domain: domain.name })}</p>
          <div className="grid gap-3">
            <CopyField label={ts.domain.recordType} value={domain.dnsRecord.type} />
            <CopyField label={ts.domain.recordName} value={domain.dnsRecord.name} />
            <CopyField label={ts.domain.recordValue} value={domain.dnsRecord.value} />
          </div>
        </div>
      )}
    </li>
  );
}
