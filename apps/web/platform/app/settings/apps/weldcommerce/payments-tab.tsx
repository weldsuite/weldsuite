/**
 * The Payments tab of Settings → Apps → WeldCommerce: the workspace's Mollie
 * connection. Mollie Connect (OAuth) sends the member to Mollie and back to
 * this tab with `?mollie=connected|error&reason=…`, which is shown once and
 * then removed from the URL; an API key is the fallback when the install has
 * no Mollie Connect app. Reading is `commerce_settings:read`, changing is
 * `commerce_settings:update`. Keys and tokens never come back from the API, so
 * nothing here can show them.
 */

import { useEffect, useRef, useState } from 'react';
import { CreditCard, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import {
  isOauthAvailable,
  useAuthorizeMollie,
  useDisconnectPayments,
  useMollieProfiles,
  usePaymentConnection,
  useUpdatePaymentConnection,
  type MollieProfile,
  type PaymentConnection,
} from '@/hooks/queries/use-commerce-payments-queries';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { getTranslations } from '@/lib/i18n';
import { connectionStatusLabel, connectionStatusTone, httpsUrl, paymentErrorMessage } from '@/app/weldcommerce/lib/payments';
import { fill } from '@/app/weldcommerce/lib/text';
import { MollieKeyDialog } from './mollie-key-dialog';

/** What Mollie sent back in the query string of the callback. */
export interface MollieCallback {
  mollie?: string;
  reason?: string;
}

/**
 * Shows the result of the Mollie callback once (a toast, and a banner that
 * stays until dismissed, since a toast is gone before an error is read), then
 * asks the page to clean the query string.
 */
function useCallbackNotice(callback: MollieCallback | undefined, onHandled: () => void) {
  const t = getTranslations('commerce').payments.callback;
  const [notice, setNotice] = useState<{ kind: 'connected' | 'error'; text: string } | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || !callback?.mollie) return;
    handled.current = true;
    if (callback.mollie === 'connected') {
      toast.success(t.connected);
      setNotice({ kind: 'connected', text: t.connected });
    } else {
      const text = callback.reason ? fill(t.errorReason, { reason: callback.reason }) : t.error;
      toast.error(text);
      setNotice({ kind: 'error', text });
    }
    onHandled();
  }, [callback, onHandled, t]);

  return { notice, dismiss: () => setNotice(null) };
}

function ConnectActions({
  oauthAvailable,
  reconnect,
  onUseKey,
}: Readonly<{ oauthAvailable: boolean; reconnect?: boolean; onUseKey: () => void }>) {
  const t = getTranslations('commerce').payments;
  const common = getTranslations('commerce').common;
  const authorize = useAuthorizeMollie();
  // Stays true after the call: the browser is on its way to Mollie.
  const [redirecting, setRedirecting] = useState(false);

  const connect = async () => {
    try {
      const res = await authorize.mutateAsync(undefined);
      const url = httpsUrl(res.data?.url);
      if (!url) {
        toast.error(t.redirectInvalid);
        return;
      }
      setRedirecting(true);
      window.location.assign(url);
    } catch (err) {
      toast.error(paymentErrorMessage(err, common.saveFailed));
    }
  };

  const busy = authorize.isPending || redirecting;
  const idleLabel = reconnect ? t.reconnect : t.connect;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!oauthAvailable || busy} aria-describedby={oauthAvailable ? undefined : 'mollie-oauth-unavailable'} onClick={() => void connect()}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
          {busy ? t.redirecting : idleLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onUseKey}>
          <KeyRound className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t.useApiKey}
        </Button>
      </div>
      {!oauthAvailable && (
        <p id="mollie-oauth-unavailable" className="text-sm text-muted-foreground">
          {t.oauthUnavailable}
        </p>
      )}
    </div>
  );
}

function ProfileField({ connection, canUpdate }: Readonly<{ connection: PaymentConnection; canUpdate: boolean }>) {
  const t = getTranslations('commerce').payments;
  const common = getTranslations('commerce').common;
  const profiles = useMollieProfiles();
  const update = useUpdatePaymentConnection();

  const change = async (profileId: string) => {
    try {
      await update.mutateAsync({ profileId });
      toast.success(t.toastProfile);
    } catch (err) {
      toast.error(paymentErrorMessage(err, common.saveFailed));
    }
  };

  if (profiles.isError) return <p className="text-sm text-destructive">{t.profilesFailed}</p>;
  const options: MollieProfile[] = profiles.data?.data ?? [];
  const label = (profile: MollieProfile) => (profile.website ? `${profile.name} · ${profile.website}` : profile.name);

  return (
    <div className="space-y-1.5">
      <label htmlFor="mollie-profile" className="text-sm font-medium">
        {t.profileLabel}
      </label>
      <Select value={connection.profileId ?? ''} disabled={!canUpdate || profiles.isPending || update.isPending} onValueChange={(value) => void change(value)}>
        <SelectTrigger id="mollie-profile" className="sm:max-w-sm">
          <SelectValue placeholder={t.profilePlaceholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>
              {label(profile)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t.profileHint}</p>
    </div>
  );
}

function TestmodeField({ connection, canUpdate }: Readonly<{ connection: PaymentConnection; canUpdate: boolean }>) {
  const t = getTranslations('commerce').payments;
  const common = getTranslations('commerce').common;
  const update = useUpdatePaymentConnection();
  // An API key decides its own mode: the switch shows it and says why it cannot change.
  const fixed = connection.authMethod === 'api_key';

  const change = async (testmode: boolean) => {
    try {
      await update.mutateAsync({ testmode });
      toast.success(testmode ? t.toastTestmodeOn : t.toastTestmodeOff);
    } catch (err) {
      toast.error(paymentErrorMessage(err, common.saveFailed));
    }
  };

  return (
    <div className="flex items-start justify-between gap-6">
      <div className="space-y-1">
        <label htmlFor="mollie-testmode" className="text-sm font-medium">
          {t.testmodeLabel}
        </label>
        <p id="mollie-testmode-hint" className="text-sm text-muted-foreground">
          {fixed ? t.testmodeFixed : t.testmodeHint}
        </p>
      </div>
      <Switch
        id="mollie-testmode"
        checked={connection.testmode}
        disabled={fixed || !canUpdate || update.isPending}
        aria-describedby="mollie-testmode-hint"
        onCheckedChange={(checked) => void change(checked)}
      />
    </div>
  );
}

function ConnectionFacts({ connection }: Readonly<{ connection: PaymentConnection }>) {
  const t = getTranslations('commerce').payments;
  return (
    <FieldGrid
      fields={[
        { label: t.fields.organisation, value: connection.organizationName },
        { label: t.fields.profile, value: connection.profileName },
        { label: t.fields.method, value: t.authMethod[connection.authMethod] },
        { label: t.fields.connectedOn, value: formatPanelDate(connection.connectedAt) },
      ]}
    />
  );
}

function ConnectionTitle({ connection }: Readonly<{ connection: PaymentConnection }>) {
  const t = getTranslations('commerce').payments;
  return (
    <span className="flex flex-wrap items-center gap-2">
      Mollie
      <SoftBadge tone={connectionStatusTone(connection.status)}>{connectionStatusLabel(connection.status)}</SoftBadge>
      <SoftBadge tone={connection.testmode ? 'warning' : 'neutral'}>{connection.testmode ? t.testMode : t.liveMode}</SoftBadge>
    </span>
  );
}

/** Reconnect (OAuth, when Mollie asked for it) or replace the key, and disconnect. */
function ConnectionFooter({
  connection,
  oauthAvailable,
  onUseKey,
  onDisconnect,
}: Readonly<{ connection: PaymentConnection; oauthAvailable: boolean; onUseKey: () => void; onDisconnect: () => void }>) {
  const t = getTranslations('commerce').payments;
  const reconnectOauth = connection.status === 'needs_reauth' && connection.authMethod === 'oauth';
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-t pt-4">
      {reconnectOauth ? (
        <ConnectActions oauthAvailable={oauthAvailable} reconnect onUseKey={onUseKey} />
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={onUseKey}>
          <KeyRound className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t.replaceKey}
        </Button>
      )}
      <Button type="button" size="sm" variant="outline" onClick={onDisconnect}>
        {t.disconnect}
      </Button>
    </div>
  );
}

function ConnectionCard({
  connection,
  canUpdate,
  oauthAvailable,
}: Readonly<{ connection: PaymentConnection; canUpdate: boolean; oauthAvailable: boolean }>) {
  const t = getTranslations('commerce').payments;
  const common = getTranslations('commerce').common;
  const disconnect = useDisconnectPayments();
  const [keyDialog, setKeyDialog] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const needsReauth = connection.status === 'needs_reauth';
  const isOauth = connection.authMethod === 'oauth';

  const confirmDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      toast.success(t.toastDisconnected);
    } catch (err) {
      toast.error(paymentErrorMessage(err, common.deleteFailed));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <SectionCard
      title={<ConnectionTitle connection={connection} />}
      description={connection.testmode ? t.testModeHint : undefined}
      contentClassName="space-y-5"
    >
      {needsReauth && (
        <InfoBanner variant="warning" title={t.reauthTitle}>
          {t.reauthDescription}
          {connection.lastError && <span className="mt-1 block break-words">{fill(t.lastError, { error: connection.lastError })}</span>}
        </InfoBanner>
      )}
      <ConnectionFacts connection={connection} />
      {canUpdate && isOauth && !needsReauth && <ProfileField connection={connection} canUpdate={canUpdate} />}
      {!needsReauth && <TestmodeField connection={connection} canUpdate={canUpdate} />}
      {canUpdate && (
        <ConnectionFooter
          connection={connection}
          oauthAvailable={oauthAvailable}
          onUseKey={() => setKeyDialog(true)}
          onDisconnect={() => setConfirming(true)}
        />
      )}
      {keyDialog && <MollieKeyDialog open onOpenChange={setKeyDialog} />}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t.disconnectTitle}
        description={t.disconnectDescription}
        variant="destructive"
        confirmLabel={t.disconnectConfirm}
        cancelLabel={getTranslations('common').actions.cancel}
        onConfirm={confirmDisconnect}
      />
    </SectionCard>
  );
}

function NotConnectedCard({ oauthAvailable, canUpdate }: Readonly<{ oauthAvailable: boolean; canUpdate: boolean }>) {
  const t = getTranslations('commerce').payments;
  const [keyDialog, setKeyDialog] = useState(false);
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <CreditCard className="h-4 w-4" aria-hidden="true" />
          {t.notConnectedTitle}
        </span>
      }
      description={t.notConnectedDescription}
    >
      {canUpdate ? <ConnectActions oauthAvailable={oauthAvailable} onUseKey={() => setKeyDialog(true)} /> : <p className="text-sm text-muted-foreground">{t.readOnly}</p>}
      {keyDialog && <MollieKeyDialog open onOpenChange={setKeyDialog} />}
    </SectionCard>
  );
}

export function PaymentsTab({
  callback,
  onCallbackHandled,
}: Readonly<{ callback?: MollieCallback; onCallbackHandled: () => void }>) {
  const t = getTranslations('commerce').payments;
  const permissions = usePermissionsMaybe();
  const canRead = permissions?.can('commerce_settings:read') ?? false;
  const canUpdate = permissions?.can('commerce_settings:update') ?? false;
  const connection = usePaymentConnection(canRead);
  const { notice, dismiss } = useCallbackNotice(callback, onCallbackHandled);

  if (!canRead) return <p className="text-sm text-muted-foreground">{t.noPermission}</p>;
  if (connection.isPending) return <PageLoader fullScreen={false} />;
  if (connection.isError) return <ErrorState message={t.loadFailed} onRetry={() => void connection.refetch()} />;

  const current = connection.data.data;
  const oauthAvailable = isOauthAvailable(connection.data);
  const connected = current !== null && current.status !== 'disconnected';

  return (
    <div className="min-w-0 space-y-4">
      <div>
        <h2 className="text-base font-semibold">{t.title}</h2>
        <p className="text-sm text-muted-foreground">{t.description}</p>
      </div>
      {notice && (
        <InfoBanner variant={notice.kind === 'connected' ? 'success' : 'danger'} dismissible onDismiss={dismiss}>
          {notice.text}
        </InfoBanner>
      )}
      {connected ? (
        <ConnectionCard connection={current} canUpdate={canUpdate} oauthAvailable={oauthAvailable} />
      ) : (
        <NotConnectedCard oauthAvailable={oauthAvailable} canUpdate={canUpdate} />
      )}
      {!canUpdate && connected && <p className="text-sm text-muted-foreground">{t.readOnly}</p>}
    </div>
  );
}
