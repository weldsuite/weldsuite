import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { SSO_PROVIDER_IDS, type SsoConfigView, type SsoProviderId } from '@weldsuite/app-api-client/schemas/sso';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useRemoveSsoConnection, useSaveSsoConnection } from '@/hooks/queries/use-sso-queries';
import { CopyField } from './copy-field';
import { ssoErrorMessage } from './sso-errors';
import { InlineError, Notice, StepCard } from './sso-parts';
import {
  connectionInputFrom,
  idpFormValues,
  idpIssues,
  type IdpFormValues,
  type IdpMethod,
  type SsoConnection,
  type SsoIdp,
} from './sso-view';

const IDP_METHODS: readonly IdpMethod[] = ['url', 'xml', 'manual'];

interface SsoConnectionStepProps {
  config: SsoConfigView;
  canManage: boolean;
}

/** Step 2: create the Clerk SAML connection, then exchange details with the identity provider. */
export function SsoConnectionStep({ config, canManage }: Readonly<SsoConnectionStepProps>) {
  const { t } = useI18n();
  const copy = t.settings.sso.connection;
  const connection = config.connection;

  const header = {
    step: 2,
    title: copy.title,
    description: copy.description,
  } as const;

  if (!config.entitlement.entitled) {
    return (
      <StepCard {...header}>
        <Notice>{copy.needsEntitlement}</Notice>
      </StepCard>
    );
  }
  if (!config.domain?.verified) {
    return (
      <StepCard {...header}>
        <Notice>{copy.needsDomain}</Notice>
      </StepCard>
    );
  }
  if (!connection) {
    return (
      <StepCard {...header}>
        {canManage ? <CreateConnection /> : <p className="text-sm text-muted-foreground">{copy.notConnected}</p>}
      </StepCard>
    );
  }

  return (
    <StepCard
      {...header}
      done={connection.idpConfigured}
      badge={
        <Badge variant={connection.idpConfigured ? 'success' : 'secondary'}>
          {connection.idpConfigured ? copy.complete : copy.incomplete}
        </Badge>
      }
    >
      <ConnectionDetails connection={connection} domain={config.domain.name} canManage={canManage} />
    </StepCard>
  );
}

// ============================================================================
// Provider picker
// ============================================================================

function ProviderSelect({
  id,
  value,
  onChange,
  disabled,
}: Readonly<{ id: string; value: SsoProviderId | ''; onChange: (value: SsoProviderId) => void; disabled?: boolean }>) {
  const { t } = useI18n();
  const copy = t.settings.sso.connection;
  return (
    <Select value={value} onValueChange={(next) => onChange(next as SsoProviderId)} disabled={disabled}>
      <SelectTrigger id={id} className="max-w-sm">
        <SelectValue placeholder={copy.providerPlaceholder} />
      </SelectTrigger>
      <SelectContent>
        {SSO_PROVIDER_IDS.map((provider) => (
          <SelectItem key={provider} value={provider}>
            {copy.providers[provider]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ============================================================================
// Before the connection exists
// ============================================================================

/** The first save creates the connection, so the service provider values exist to copy. */
function CreateConnection() {
  const { t } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.connection;
  const save = useSaveSsoConnection();
  const [provider, setProvider] = useState<SsoProviderId | ''>('');
  const [error, setError] = useState<unknown>(null);

  const create = async () => {
    if (!provider) return;
    setError(null);
    try {
      await save.mutateAsync({ provider });
      toast.success(copy.created);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="sso-provider-create">{copy.provider}</Label>
        <ProviderSelect id="sso-provider-create" value={provider} onChange={setProvider} disabled={save.isPending} />
        <p className="text-sm text-muted-foreground">{copy.createHint}</p>
      </div>
      <Button type="button" size="sm" disabled={!provider || save.isPending} onClick={() => void create()}>
        {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {copy.create}
      </Button>
      {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors)}</InlineError>}
    </div>
  );
}

// ============================================================================
// Once it exists
// ============================================================================

function ConnectionDetails({
  connection,
  domain,
  canManage,
}: Readonly<{ connection: SsoConnection; domain: string; canManage: boolean }>) {
  const { t, plural, format } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.connection;
  const remove = useRemoveSsoConnection();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const removeConnection = async () => {
    setError(null);
    try {
      await remove.mutateAsync();
      toast.success(copy.removed);
    } catch (err) {
      setError(err);
    } finally {
      setRemoveOpen(false);
    }
  };

  const sp = connection.sp;
  const hasSp = Boolean(sp.acsUrl || sp.entityId || sp.metadataUrl);

  return (
    <div className="space-y-6">
      {hasSp && (
        <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{copy.spTitle}</p>
            <p className="text-sm text-muted-foreground">{copy.spDescription}</p>
          </div>
          <div className="grid gap-3">
            {sp.acsUrl && <CopyField label={copy.acsUrl} value={sp.acsUrl} />}
            {sp.entityId && <CopyField label={copy.spEntityId} value={sp.entityId} />}
            {sp.metadataUrl && <CopyField label={copy.spMetadataUrl} value={sp.metadataUrl} />}
          </div>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-sm font-medium">{copy.idpTitle}</p>
        <p className="text-sm text-muted-foreground">{copy.idpDescription}</p>
      </div>

      {canManage ? (
        // The form starts from what is saved; saving bumps `updatedAt`, which starts it over from the new state.
        <IdpForm key={connection.updatedAt ?? 'new'} connection={connection} />
      ) : (
        <IdpSummary connection={connection} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          {connection.userCount !== null ? plural(connection.userCount, copy.userCount) : ''}
        </p>
        {canManage && (
          <Button type="button" variant="outline" size="sm" onClick={() => setRemoveOpen(true)}>
            {copy.remove}
          </Button>
        )}
      </div>
      {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors)}</InlineError>}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={copy.removeConfirmTitle}
        description={format(copy.removeConfirmDescription, { domain })}
        confirmLabel={copy.remove}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={removeConnection}
      />
    </div>
  );
}

/** What the connection holds, for someone who may look but not change it. */
function IdpSummary({ connection }: Readonly<{ connection: SsoConnection }>) {
  const { t } = useI18n();
  const copy = t.settings.sso.connection;
  const { idp } = connection;
  const rows: Array<[string, string]> = [
    [copy.provider, copy.providers[connection.provider]],
    [copy.summary.metadataUrl, idp.metadataUrl ?? copy.summary.none],
    [copy.summary.metadata, idp.hasMetadata ? copy.summary.metadataStored : copy.summary.none],
    [copy.summary.entityId, idp.entityId ?? copy.summary.none],
    [copy.summary.ssoUrl, idp.ssoUrl ?? copy.summary.none],
    [copy.summary.certificate, idp.hasCertificate ? copy.summary.certificateStored : copy.summary.none],
  ];
  return (
    <dl className="divide-y rounded-lg border text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-muted-foreground sm:w-48">{label}</dt>
          <dd className="min-w-0 break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ============================================================================
// Identity provider form
// ============================================================================

function buildIdpSchema(ts: ReturnType<typeof useI18n>['t']['settings']['sso'], idp: SsoIdp) {
  return z
    .object({
      provider: z.enum(SSO_PROVIDER_IDS),
      method: z.enum(['url', 'xml', 'manual']),
      metadataUrl: z.string(),
      metadataXml: z.string(),
      entityId: z.string(),
      ssoUrl: z.string(),
      certificate: z.string(),
    })
    .superRefine((values, ctx) => {
      for (const issue of idpIssues(values, idp)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.field], message: ts.validation[issue.code] });
      }
    });
}

function IdpForm({ connection }: Readonly<{ connection: SsoConnection }>) {
  const { t } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.connection;
  const save = useSaveSsoConnection();
  const [error, setError] = useState<unknown>(null);
  const { idp } = connection;

  const schema = useMemo(() => buildIdpSchema(ts, idp), [ts, idp]);
  const form = useForm<IdpFormValues>({
    resolver: zodResolver(schema),
    defaultValues: idpFormValues(connection.provider, idp),
  });
  const method = form.watch('method');

  const submit = async (values: IdpFormValues) => {
    setError(null);
    try {
      await save.mutateAsync(connectionInputFrom(values, idp));
      toast.success(copy.saved);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-5">
        <FormField
          control={form.control}
          name="provider"
          render={({ field }) => (
            <FormItem>
              <Label htmlFor="sso-provider">{copy.provider}</Label>
              <ProviderSelect id="sso-provider" value={field.value} onChange={field.onChange} />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="method"
          render={({ field }) => (
            <FormItem>
              <p id="sso-method-label" className="text-sm font-medium leading-none">
                {copy.methodLabel}
              </p>
              <RadioGroup aria-labelledby="sso-method-label" value={field.value} onValueChange={field.onChange} className="gap-2">
                {IDP_METHODS.map((option) => (
                  <Label
                    key={option}
                    htmlFor={`sso-method-${option}`}
                    className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                  >
                    <RadioGroupItem id={`sso-method-${option}`} value={option} />
                    {copy.method[option]}
                  </Label>
                ))}
              </RadioGroup>
            </FormItem>
          )}
        />

        {method === 'url' && (
          <FormField
            control={form.control}
            name="metadataUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{copy.metadataUrl}</FormLabel>
                <FormControl>
                  <Input {...field} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder={copy.metadataUrlPlaceholder} />
                </FormControl>
                <FormDescription>{copy.metadataUrlHelp}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {method === 'xml' && (
          <FormField
            control={form.control}
            name="metadataXml"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{copy.metadataXml}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={6} spellCheck={false} placeholder={copy.metadataXmlPlaceholder} className="font-mono text-[13px]" />
                </FormControl>
                {idp.hasMetadata && <FormDescription>{copy.metadataXmlStored}</FormDescription>}
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {method === 'manual' && (
          <div className="space-y-4">
            <FormField
              control={form.control}
              name="entityId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{copy.entityId}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" spellCheck={false} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ssoUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{copy.ssoUrl}</FormLabel>
                  <FormControl>
                    <Input {...field} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder={copy.ssoUrlPlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="certificate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{copy.certificate}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={6} spellCheck={false} placeholder={copy.certificatePlaceholder} className="font-mono text-[13px]" />
                  </FormControl>
                  {idp.hasCertificate && <FormDescription>{copy.certificateStored}</FormDescription>}
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}

        {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors)}</InlineError>}

        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {copy.save}
        </Button>
      </form>
    </Form>
  );
}
