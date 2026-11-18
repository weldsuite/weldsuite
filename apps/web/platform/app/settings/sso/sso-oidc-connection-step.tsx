import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
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
import type { SsoConfigView, SsoOidcView, SsoProtocol } from '@weldsuite/app-api-client/schemas/sso';
import { useI18n } from '@/lib/i18n/provider';
import { useRemoveSsoConnection, useSaveSsoOidcConnection } from '@/hooks/queries/use-sso-queries';
import { CopyField } from './copy-field';
import { ssoErrorMessage } from './sso-errors';
import { InlineError, StepCard } from './sso-parts';
import {
  SsoProtocolChoice,
  SsoSamlConnectionForm,
  SsoSamlConnectionSummary,
  SsoSamlRegisterPanel,
} from './sso-saml-connection';
import {
  isSamlConnection,
  oidcFormValues,
  oidcInputFrom,
  oidcIssues,
  type OidcFormValues,
  type OidcIssueCode,
  type SsoOidcConnection,
} from './sso-view';

interface SsoOidcConnectionStepProps {
  config: SsoConfigView;
  oidc: SsoOidcView;
  canManage: boolean;
}

/**
 * WeldID mode, step 1: the connection at WeldID, over OpenID Connect or
 * SAML (chosen once; switching means removing it). The first save creates
 * it and brings back what to register at the identity provider: the
 * redirect URI (OpenID Connect; the client secret is write-only), or the
 * entity ID and reply URL (SAML, created from the identity provider's
 * metadata).
 */
export function SsoOidcConnectionStep({ config, oidc, canManage }: Readonly<SsoOidcConnectionStepProps>) {
  const { t } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.weldid.connection;
  const connection = oidc.connection;

  const remove = useRemoveSsoConnection();
  const [editing, setEditing] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [protocol, setProtocol] = useState<SsoProtocol>('oidc');
  const saml = connection ? isSamlConnection(connection) : protocol === 'saml';

  const showForm = canManage && (!connection || editing);
  const closeForm = () => setEditing(false);
  const cancel = connection ? closeForm : undefined;

  const removeConnection = async () => {
    setError(null);
    try {
      await remove.mutateAsync();
      setEditing(false);
      toast.success(copy.removed);
    } catch (err) {
      setError(err);
    } finally {
      setRemoveOpen(false);
    }
  };

  const header = { step: 1, title: copy.title, description: copy.description } as const;

  if (!connection && !config.entitlement.entitled) {
    return (
      <StepCard {...header}>
        <InfoBanner variant="neutral">{ts.weldid.notEntitled}</InfoBanner>
      </StepCard>
    );
  }

  return (
    <StepCard
      {...header}
      done={Boolean(connection)}
      badge={connection ? <Badge variant="success">{connection.displayName}</Badge> : undefined}
    >
      {showForm && !connection && <SsoProtocolChoice value={protocol} onChange={setProtocol} />}

      {showForm && saml && <SsoSamlConnectionForm connection={connection} onSaved={closeForm} onCancel={cancel} />}

      {showForm && !saml && <OidcConnectionForm connection={connection} onSaved={closeForm} onCancel={cancel} />}

      {!showForm && !connection && <p className="text-sm text-muted-foreground">{copy.notConnected}</p>}

      {!showForm && connection && (
        <SavedConnection
          connection={connection}
          saml={saml}
          canManage={canManage}
          onEdit={() => setEditing(true)}
          onRemove={() => setRemoveOpen(true)}
        />
      )}

      {connection && saml && <SsoSamlRegisterPanel connection={connection} />}

      {connection && !saml && <OidcRedirectPanel connection={connection} />}

      {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors, true)}</InlineError>}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={copy.removeConfirmTitle}
        description={copy.removeConfirmDescription}
        confirmLabel={copy.remove}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={removeConnection}
      />
    </StepCard>
  );
}

interface OidcConnectionFormProps {
  connection: SsoOidcConnection | null;
  onSaved: () => void;
  onCancel?: () => void;
}

/**
 * Create the OpenID Connect connection, or change a saved one. It opens
 * from what is saved (never the secret) and sends only what changed.
 */
function OidcConnectionForm({ connection, onSaved, onCancel }: Readonly<OidcConnectionFormProps>) {
  const { t } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.weldid.connection;
  const save = useSaveSsoOidcConnection();
  const [error, setError] = useState<unknown>(null);

  const schema = useMemo(() => {
    const messages: Record<OidcIssueCode, string> = {
      required: ts.validation.required,
      httpsUrl: ts.validation.httpsUrl,
      scopes: copy.scopesInvalid,
    };
    return z
      .object({
        displayName: z.string(),
        issuer: z.string(),
        clientId: z.string(),
        clientSecret: z.string(),
        scopes: z.string(),
        trustEmails: z.boolean(),
      })
      .superRefine((values, ctx) => {
        for (const issue of oidcIssues(values, connection)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.field], message: messages[issue.code] });
        }
      });
  }, [ts, copy, connection]);

  const form = useForm<OidcFormValues>({
    resolver: zodResolver(schema),
    defaultValues: oidcFormValues(connection),
  });

  const submit = async (values: OidcFormValues) => {
    setError(null);
    const input = oidcInputFrom(values, connection);
    if (connection && Object.keys(input).length === 0) {
      onSaved();
      return;
    }
    try {
      await save.mutateAsync(input);
      toast.success(connection ? copy.saved : copy.created);
      onSaved();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-4">
        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.displayName}</FormLabel>
              <FormControl>
                <Input {...field} placeholder={copy.displayNamePlaceholder} autoComplete="off" className="max-w-sm" />
              </FormControl>
              <FormDescription>{copy.displayNameHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="issuer"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.issuer}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="url"
                  inputMode="url"
                  placeholder={copy.issuerPlaceholder}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </FormControl>
              <FormDescription>{copy.issuerHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="clientId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.clientId}</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="off" autoCapitalize="none" spellCheck={false} className="max-w-md" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="clientSecret"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.clientSecret}</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="new-password" className="max-w-md" />
              </FormControl>
              {connection?.hasClientSecret && <FormDescription>{copy.clientSecretStored}</FormDescription>}
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="scopes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.scopes}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder={copy.scopesPlaceholder}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="max-w-md"
                />
              </FormControl>
              <FormDescription>{copy.scopesHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="trustEmails"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-3">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
              </FormControl>
              <div className="space-y-1">
                <FormLabel>{copy.trustEmails}</FormLabel>
                <FormDescription>{copy.trustEmailsHint}</FormDescription>
              </div>
            </FormItem>
          )}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {connection ? copy.save : copy.create}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {t.common.actions.cancel}
            </Button>
          )}
        </div>
        {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors, true)}</InlineError>}
      </form>
    </Form>
  );
}

interface SavedConnectionProps {
  connection: SsoOidcConnection;
  saml: boolean;
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
}

/** A saved connection's details, with Change and Remove for a manager. */
function SavedConnection({ connection, saml, canManage, onEdit, onRemove }: Readonly<SavedConnectionProps>) {
  const { t } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.weldid.connection;
  return (
    <div className="space-y-4">
      {saml ? <SsoSamlConnectionSummary connection={connection} /> : <OidcConnectionSummary connection={connection} />}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            {ts.domain.change}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onRemove}>
            {copy.remove}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A saved OpenID Connect connection: never its secret, only whether one is stored. */
function OidcConnectionSummary({ connection }: Readonly<{ connection: SsoOidcConnection }>) {
  const { t } = useI18n();
  const copy = t.settings.sso.weldid.connection;
  return (
    <FieldGrid
      fields={[
        { label: copy.displayName, value: connection.displayName },
        { label: copy.issuer, value: <span className="break-all">{connection.issuer}</span> },
        { label: copy.clientId, value: <span className="break-all font-mono text-[13px]">{connection.clientId}</span> },
        { label: copy.clientSecret, value: connection.hasClientSecret ? copy.secretStored : null },
        { label: copy.scopes, value: connection.scopes.length > 0 ? connection.scopes.join(' ') : null },
        { label: copy.trustEmails, value: connection.trustEmails ? copy.trustEmailsOn : copy.trustEmailsOff },
      ]}
    />
  );
}

/** The redirect URI to register at the identity provider (WeldID's callback for this connection). */
function OidcRedirectPanel({ connection }: Readonly<{ connection: SsoOidcConnection }>) {
  const { t } = useI18n();
  const copy = t.settings.sso.weldid.connection;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{copy.redirectTitle}</p>
        <p className="text-sm text-muted-foreground">{copy.redirectDescription}</p>
      </div>
      {connection.redirectUri ? (
        <CopyField label={copy.redirectUri} value={connection.redirectUri} />
      ) : (
        <p className="text-sm text-muted-foreground">{copy.redirectPending}</p>
      )}
    </div>
  );
}
