/**
 * The online payments of one entity (Settings → Entities → (entity) →
 * WeldBooks, edition feature `books-online-payments`): connect the entity's own
 * Mollie account through Mollie Connect or an API key, choose the payment
 * methods, read the payouts and disconnect. Customers then pay an invoice from
 * the e-mail and the payment is booked on the "Mollie" money account.
 *
 * Connecting and disconnecting need a second factor: `weldbooksApi` asks for it
 * (step-up) and sends the call once more, so the card only says so.
 */

import { useEffect, useId, useState, type FormEvent } from 'react';
import { CreditCard, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { RecordLink } from '@/components/object-panel/record-link';
import {
  isOnlinePaymentsAvailable,
  useAuthorizeMollie,
  useConnectMollieApiKey,
  useDisconnectMollie,
  useMollieMethods,
  usePaymentConnection,
  useSyncSettlements,
  useUpdatePaymentMethods,
} from '@/hooks/queries/use-weldbooks-payments-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import {
  paymentErrorCode,
  paymentErrorStatus,
  type MollieMethod,
  type PaymentConnection,
} from '@/lib/api/domains/weldbooks-payments';
import { useI18n } from '@/lib/i18n/provider';
import {
  methodLabel,
  parseMollieReturn,
  redirectBrowser,
  safeAuthorizeUrl,
  withoutMollieReturn,
  type MollieReturn,
} from '@/lib/weldbooks/online-payments';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** What Mollie Connect sent the person back with, read once; the params leave the address. */
function useMollieReturn(): [MollieReturn | null, () => void] {
  const [returned, setReturned] = useState<MollieReturn | null>(() => parseMollieReturn(globalThis.location?.search ?? ''));

  useEffect(() => {
    const { pathname, search, hash } = globalThis.location;
    if (!parseMollieReturn(search)) return;
    globalThis.history.replaceState(globalThis.history.state, '', withoutMollieReturn(pathname, search, hash));
  }, []);

  return [returned, () => setReturned(null)];
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

// ----------------------------------------------------------------------------
// Not connected
// ----------------------------------------------------------------------------

function ApiKeyForm({ onCancel, onConnected }: Readonly<{ onCancel: () => void; onConnected: () => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksPayments.settings;
  const ids = useId();
  const connect = useConnectMollieApiKey();
  const [apiKey, setApiKey] = useState('');
  const [profileId, setProfileId] = useState('');
  const [visible, setVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (connect.isPending) return;
    const key = apiKey.trim();
    if (!key) {
      setProblem(copy.apiKey.required);
      return;
    }
    setProblem(null);
    connect.mutate(
      { apiKey: key, profileId: profileId.trim() || undefined },
      {
        onSuccess: () => {
          setApiKey('');
          toast.success(copy.returned.connected);
          onConnected();
        },
        onError: (error) => {
          // A key Mollie refuses is a 400 with a message to show; anything else is a failed call.
          setProblem(paymentErrorStatus(error) === 400 ? (messageOf(error) ?? copy.apiKey.rejected) : (messageOf(error) ?? copy.apiKey.failed));
        },
      },
    );
  };

  const problemId = `${ids}-problem`;
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4" data-testid="mollie-api-key-form" aria-label={copy.useApiKey}>
      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-key`}>{copy.apiKey.label}</Label>
        <div className="flex gap-2">
          <Input
            id={`${ids}-key`}
            name="mollieApiKey"
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            required
            placeholder="live_..."
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              if (problem) setProblem(null);
            }}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${ids}-help ${problemId}` : `${ids}-help`}
            className="font-mono sm:max-w-md"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-pressed={visible}
            aria-label={visible ? copy.apiKey.hide : copy.apiKey.show}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
        <p id={`${ids}-help`} className="text-xs text-muted-foreground">
          {copy.apiKey.help}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-profile`}>{copy.apiKey.profileLabel}</Label>
        <Input
          id={`${ids}-profile`}
          name="mollieProfileId"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="pfl_..."
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
          aria-describedby={`${ids}-profile-help`}
          className="font-mono sm:max-w-xs"
        />
        <p id={`${ids}-profile-help`} className="text-xs text-muted-foreground">
          {copy.apiKey.profileHelp}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{copy.apiKey.limits}</p>
      <div aria-live="polite">
        {problem ? (
          <p id={problemId} className="text-sm text-destructive" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={connect.isPending}>
          {connect.isPending ? copy.apiKey.connecting : copy.apiKey.connect}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </div>
    </form>
  );
}

/** "Connect Mollie" (OAuth, preferred) and the API key path. */
function ConnectOptions({ canEdit }: Readonly<{ canEdit: boolean }>) {
  const { t } = useI18n();
  const copy = t.weldbooksPayments.settings;
  const { entityId } = useCurrentAccountingEntity();
  const workspaceUrl = useWorkspaceUrl();
  const authorize = useAuthorizeMollie();
  const [keyOpen, setKeyOpen] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  const connect = () => {
    // Mollie sends the person back to the entity's WeldBooks tab with `?mollie=connected` or `?mollie=error`.
    const returnUrl = workspaceUrl(`/settings/entities/${entityId}/edit?tab=weldbooks`);
    authorize.mutate(returnUrl, {
      onSuccess: (res) => {
        const url = safeAuthorizeUrl(res.data.authorizeUrl);
        if (url) redirectBrowser(url);
        else toast.error(copy.authorizeFailed);
      },
      onError: (error) => {
        if (paymentErrorCode(error) === 'MOLLIE_CONNECT_NOT_CONFIGURED') {
          setNotConfigured(true);
          setKeyOpen(true);
        } else toast.error(copy.authorizeFailed, { description: messageOf(error) });
      },
    });
  };

  if (!canEdit) return <p className="text-sm text-muted-foreground">{copy.readOnly}</p>;

  return (
    <div className="space-y-4">
      {notConfigured ? (
        <InfoBanner variant="info" data-testid="mollie-not-configured">
          {copy.notConfigured}
        </InfoBanner>
      ) : (
        <div className="space-y-2">
          <Button type="button" onClick={connect} disabled={authorize.isPending}>
            <CreditCard className="mr-1 h-4 w-4" aria-hidden />
            {authorize.isPending ? copy.connecting : copy.connect}
          </Button>
          <p className="text-xs text-muted-foreground">{copy.connectHint}</p>
        </div>
      )}
      {keyOpen ? (
        <ApiKeyForm onCancel={() => setKeyOpen(false)} onConnected={() => setKeyOpen(false)} />
      ) : (
        <Button type="button" variant="link" className="h-auto p-0" onClick={() => setKeyOpen(true)}>
          {copy.useApiKey}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{copy.stepUp}</p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Connected
// ----------------------------------------------------------------------------

function MethodPicker({ connection, canEdit }: Readonly<{ connection: PaymentConnection; canEdit: boolean }>) {
  const { t } = useI18n();
  const copy = t.weldbooksPayments.settings.methods;
  const names = t.weldbooksPayments.methodNames as Readonly<Record<string, string>>;
  const ids = useId();
  const methods = useMollieMethods(connection.id, { enabled: connection.status === 'active' });
  const save = useUpdatePaymentMethods();
  const saved = connection.methods;
  const [draft, setDraft] = useState<string[]>(saved);
  // A fresh answer from the server (a save, a refetch) replaces the draft.
  const savedKey = saved.join(',');
  useEffect(() => setDraft(savedKey ? savedKey.split(',') : []), [savedKey]);

  const available: MollieMethod[] = methods.data ?? [];
  // A method that was chosen and has since been switched off at Mollie stays listed, so it can be removed.
  const listed: MollieMethod[] = [
    ...available,
    ...saved.filter((id) => !available.some((method) => method.id === id)).map((id) => ({ id, description: id })),
  ];
  const dirty = [...draft].sort((a, b) => a.localeCompare(b)).join(',') !== [...saved].sort((a, b) => a.localeCompare(b)).join(',');

  const toggle = (id: string, on: boolean) => setDraft((current) => (on ? [...current, id] : current.filter((value) => value !== id)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || !dirty || draft.length === 0) return;
    save.mutate(
      { id: connection.id, methods: draft },
      {
        onSuccess: () => toast.success(copy.saved),
        onError: (error) => toast.error(copy.saveFailed, { description: messageOf(error) }),
      },
    );
  };

  let body: React.ReactNode;
  if (methods.isLoading) body = <InlineSpinner />;
  else if (methods.isError) body = <p className="text-sm text-destructive">{copy.loadFailed}</p>;
  else if (listed.length === 0) body = <p className="text-sm text-muted-foreground">{copy.none}</p>;
  else {
    body = (
      <fieldset className="space-y-2" disabled={!canEdit || save.isPending}>
        <legend className="sr-only">{copy.title}</legend>
        {listed.map((method) => {
          const inputId = `${ids}-${method.id}`;
          return (
            <div key={method.id} className="flex items-center gap-2">
              <Checkbox
                id={inputId}
                checked={draft.includes(method.id)}
                onCheckedChange={(checked) => toggle(method.id, checked === true)}
              />
              <Label htmlFor={inputId} className="font-normal">
                {methodLabel(method.id, names, method.description)}
              </Label>
            </div>
          );
        })}
      </fieldset>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2" aria-labelledby={`${ids}-title`} data-testid="mollie-methods">
      <div>
        <h3 id={`${ids}-title`} className="text-sm font-semibold">
          {copy.title}
        </h3>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
      </div>
      {body}
      {draft.length === 0 && listed.length > 0 ? (
        <p className="text-sm text-destructive" role="alert">
          {copy.atLeastOne}
        </p>
      ) : null}
      {canEdit && listed.length > 0 ? (
        <Button type="submit" variant="outline" size="sm" disabled={!dirty || draft.length === 0 || save.isPending}>
          {save.isPending ? copy.saving : copy.save}
        </Button>
      ) : null}
    </form>
  );
}

function PayoutsSection({ connection, canEdit }: Readonly<{ connection: PaymentConnection; canEdit: boolean }>) {
  const { t } = useI18n();
  const copy = t.weldbooksPayments.settings.sync;
  const { formatDateTime } = useWeldbooksFormat();
  const sync = useSyncSettlements();
  const [summary, setSummary] = useState<string | null>(null);

  const run = () => {
    setSummary(null);
    sync.mutate(connection.id, {
      onSuccess: (res) => {
        const result = res.data;
        setSummary(
          copy.result
            .replace('{imported}', String(result.imported))
            .replace('{skipped}', String(result.skipped))
            .replace('{booked}', String(result.booked))
            .replace('{lines}', String(result.lines))
            .replace('{toProcess}', String(result.toProcess))
            .replace('{payouts}', String(result.payouts))
            .replace('{fees}', String(result.fees)),
        );
        toast.success(copy.done);
      },
      onError: (error) =>
        toast.error(copy.failed, {
          description: paymentErrorCode(error) === 'SETTLEMENTS_UNAVAILABLE' ? copy.refused : messageOf(error),
        }),
    });
  };

  return (
    <section className="space-y-2" aria-label={copy.title} data-testid="mollie-payouts">
      <div>
        <h3 className="text-sm font-semibold">{copy.title}</h3>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
      </div>
      {connection.settlementsAvailable ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {canEdit ? (
              <Button type="button" variant="outline" size="sm" onClick={run} disabled={sync.isPending}>
                {sync.isPending ? copy.syncing : copy.action}
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {connection.settlementsSyncedAt
                ? copy.lastSynced.replace('{time}', formatDateTime(connection.settlementsSyncedAt))
                : copy.neverSynced}
            </span>
          </div>
          <div role="status">{summary ? <p className="text-sm" data-testid="mollie-sync-result">{summary}</p> : null}</div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="mollie-payouts-unavailable">
          {copy.unavailable}
        </p>
      )}
    </section>
  );
}

function connectionTone(status: string): 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success';
  if (status === 'needs_reauth') return 'warning';
  return 'danger';
}

function ConnectedView({ connection, canEdit }: Readonly<{ connection: PaymentConnection; canEdit: boolean }>) {
  const { t } = useI18n();
  const copy = t.weldbooksPayments.settings;
  const { formatDate } = useWeldbooksFormat();
  const disconnect = useDisconnectMollie();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const needsReauth = connection.status === 'needs_reauth';
  const statusLabels = copy.status as Readonly<Record<string, string>>;
  const statusTone = connectionTone(connection.status);

  const confirmDisconnect = () => {
    disconnect.mutate(connection.id, {
      onSuccess: () => {
        toast.success(copy.disconnect.done);
        setConfirmOpen(false);
      },
      onError: (error) => {
        setConfirmOpen(false);
        toast.error(copy.disconnect.failed, { description: messageOf(error) });
      },
    });
  };

  return (
    <div className="space-y-5" data-testid="mollie-connected">
      <div className="flex flex-wrap items-center gap-2">
        <SoftBadge tone={statusTone} data-testid="mollie-status">
          {statusLabels[connection.status] ?? connection.status}
        </SoftBadge>
        {connection.testmode ? (
          <SoftBadge tone="warning" data-testid="mollie-testmode">
            {copy.connected.testMode}
          </SoftBadge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {copy.connected.via[connection.authMethod]}
          {connection.connectedAt ? ` · ${copy.connected.since.replace('{date}', formatDate(connection.connectedAt))}` : ''}
        </span>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {connection.organizationName ? (
          <div>
            <dt className="text-xs text-muted-foreground">{copy.connected.organisation}</dt>
            <dd className="font-medium">{connection.organizationName}</dd>
          </div>
        ) : null}
        {connection.profileName ? (
          <div>
            <dt className="text-xs text-muted-foreground">{copy.connected.profile}</dt>
            <dd className="font-medium">{connection.profileName}</dd>
          </div>
        ) : null}
      </dl>

      {connection.testmode ? <p className="text-xs text-muted-foreground">{copy.connected.testModeHint}</p> : null}

      {needsReauth ? (
        <InfoBanner variant="warning" data-testid="mollie-reauth">
          <p>{copy.reconnectHint}</p>
          {canEdit ? <ReconnectButton /> : null}
        </InfoBanner>
      ) : null}

      {connection.lastError ? (
        <InfoBanner variant="danger" data-testid="mollie-last-error">
          {copy.connected.lastError.replace('{error}', connection.lastError)}
        </InfoBanner>
      ) : null}

      {connection.status === 'active' ? <MethodPicker connection={connection} canEdit={canEdit} /> : null}

      <PayoutsSection connection={connection} canEdit={canEdit && connection.status === 'active'} />

      <section className="space-y-1" aria-label={copy.account.title} data-testid="mollie-account">
        <h3 className="text-sm font-semibold">{copy.account.title}</h3>
        <p className="text-xs text-muted-foreground">{copy.account.description}</p>
        {connection.bankAccountId ? (
          <RecordLink type="bank_account" id={connection.bankAccountId} label={copy.account.open} icon={CreditCard} />
        ) : (
          <p className="text-xs text-muted-foreground">{copy.account.notYet}</p>
        )}
      </section>

      {canEdit ? (
        <div className="space-y-1 border-t pt-4">
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
            {copy.disconnect.action}
          </Button>
          <p className="text-xs text-muted-foreground">{copy.stepUp}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{copy.readOnly}</p>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={copy.disconnect.title}
        description={copy.disconnect.description}
        confirmLabel={copy.disconnect.confirm}
        cancelLabel={copy.disconnect.keep}
        variant="destructive"
        loading={disconnect.isPending}
        onConfirm={confirmDisconnect}
      />
    </div>
  );
}

/** "Reconnect": Mollie Connect again, on the same return address as connecting. */
function ReconnectButton() {
  const { t } = useI18n();
  const copy = t.weldbooksPayments.settings;
  const { entityId } = useCurrentAccountingEntity();
  const workspaceUrl = useWorkspaceUrl();
  const authorize = useAuthorizeMollie();

  const reconnect = () =>
    authorize.mutate(workspaceUrl(`/settings/entities/${entityId}/edit?tab=weldbooks`), {
      onSuccess: (res) => {
        const url = safeAuthorizeUrl(res.data.authorizeUrl);
        if (url) redirectBrowser(url);
        else toast.error(copy.authorizeFailed);
      },
      onError: (error) =>
        toast.error(
          paymentErrorCode(error) === 'MOLLIE_CONNECT_NOT_CONFIGURED' ? copy.notConfigured : copy.authorizeFailed,
          { description: paymentErrorCode(error) === 'MOLLIE_CONNECT_NOT_CONFIGURED' ? undefined : messageOf(error) },
        ),
    });

  return (
    <Button type="button" size="sm" className="mt-2" onClick={reconnect} disabled={authorize.isPending}>
      {authorize.isPending ? copy.connecting : copy.reconnect}
    </Button>
  );
}

// ----------------------------------------------------------------------------
// The card
// ----------------------------------------------------------------------------

export function OnlinePaymentsCard() {
  // Rust only: Global has no online payments, so there is nothing to show.
  if (!isOnlinePaymentsAvailable()) return null;
  return <OnlinePaymentsCardBody />;
}

function OnlinePaymentsCardBody() {
  const { t } = useI18n();
  const copy = t.weldbooksPayments.settings;
  const canEdit = useCan('accounts:update');
  const connection = usePaymentConnection();
  const [returned, dismissReturn] = useMollieReturn();

  let body: React.ReactNode;
  if (connection.isError && connection.data === undefined) {
    body = <ErrorState message={copy.loadFailed} retryLabel={copy.retry} onRetry={() => void connection.refetch()} />;
  } else if (connection.data === undefined) {
    body = <InlineSpinner />;
  } else if (connection.data === null) {
    body = <ConnectOptions canEdit={canEdit} />;
  } else {
    body = <ConnectedView connection={connection.data} canEdit={canEdit} />;
  }

  return (
    <Card data-testid="online-payments-card">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {returned ? (
          <InfoBanner
            variant={returned.result === 'connected' ? 'success' : 'danger'}
            title={returned.result === 'connected' ? copy.returned.connected : copy.returned.error}
            dismissible
            onDismiss={dismissReturn}
            data-testid="mollie-return"
          >
            {returned.result === 'connected'
              ? copy.returned.connectedHint
              : [returned.reason, copy.returned.errorHint].filter(Boolean).join(' ')}
          </InfoBanner>
        ) : null}
        {body}
      </CardContent>
    </Card>
  );
}
