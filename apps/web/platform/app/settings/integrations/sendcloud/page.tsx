import { useState } from 'react';
import { Globe, FileText, RefreshCw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@/components/ui/switch';
import { IntegrationDetailLayout } from '@/components/settings';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import {
  useConnectSendcloud,
  useDisconnectSendcloud,
  useSendcloudSettings,
  useSyncSendcloud,
  useUpdateSendcloudSettings,
} from '@/hooks/queries/use-sendcloud-queries';

function SendcloudLogo() {
  return (
    <img
      src="https://icons.duckduckgo.com/ip3/sendcloud.com.ico"
      alt="Sendcloud"
      className="h-7 w-7 rounded-[4px]"
    />
  );
}

export default function SendcloudSettingsPage() {
  const copy = getTranslations('settings').integrations.sendcloud;
  const shared = getTranslations('settings').integrations;
  const { canAny, isLoading: permissionsLoading } = usePermissions();
  const canManage = canAny('integrations:create', 'integrations:update');
  const { data, isLoading } = useSendcloudSettings();
  const connect = useConnectSendcloud();
  const sync = useSyncSendcloud();
  const update = useUpdateSendcloudSettings();
  const disconnect = useDisconnectSendcloud();
  const settings = data?.data;
  const connected = Boolean(settings?.connected);

  const [publicKey, setPublicKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  if (isLoading || permissionsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const handleConnect = async () => {
    try {
      await connect.mutateAsync({ publicKey, secretKey });
      setSecretKey('');
      toast.success(copy.synced);
    } catch {
      toast.error(copy.connectFailed);
    }
  };

  return (
    <>
      <IntegrationDetailLayout
        name={copy.title}
        description={copy.description}
        category="Shipping"
        icon={<SendcloudLogo />}
        connected={connected}
        canManage={canManage}
        connectLabel={copy.connect}
        onConnect={connected ? undefined : handleConnect}
        onDisconnect={connected ? () => setConfirmDisconnect(true) : undefined}
        overview={copy.overview}
        resources={[
          { label: shared.website, href: 'https://www.sendcloud.com', icon: Globe },
          { label: shared.documentation, href: 'https://sendcloud.dev/api/v3/shipments', icon: FileText },
        ]}
      >
        {!connected ? (
          <div className="space-y-4 max-w-lg">
            <div className="space-y-2">
              <Label htmlFor="sendcloud-public">{copy.publicKey}</Label>
              <Input
                id="sendcloud-public"
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder={copy.publicKeyPlaceholder}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sendcloud-secret">{copy.secretKey}</Label>
              <Input
                id="sendcloud-secret"
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder={copy.secretKeyPlaceholder}
                autoComplete="off"
              />
            </div>
            <p className="text-sm text-muted-foreground">{copy.keysHelp}</p>
            <Button
              onClick={() => void handleConnect()}
              disabled={!canManage || !publicKey || !secretKey || connect.isPending}
            >
              {copy.connect}
            </Button>
          </div>
        ) : (
          <div className="space-y-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                <p>{copy.connectedAs.replace('{name}', settings?.accountName || settings?.publicKeyMasked || 'Sendcloud')}</p>
                {settings?.lastSyncedAt ? (
                  <p>{copy.lastSynced.replace('{date}', new Date(settings.lastSyncedAt).toLocaleString())}</p>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  sync.mutate(undefined, {
                    onSuccess: () => toast.success(copy.synced),
                    onError: () => toast.error(copy.syncFailed),
                  })
                }
                disabled={!canManage || sync.isPending}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                {copy.refresh}
              </Button>
            </div>

            <section className="space-y-3">
              <div>
                <h3 className="text-base font-semibold">{copy.senders}</h3>
                <p className="text-sm text-muted-foreground">{copy.sendersHelp}</p>
              </div>
              {(settings?.senders.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">{copy.emptySenders}</p>
              ) : (
                <div className="border rounded-lg divide-y">
                  {settings?.senders.map((sender) => (
                    <div key={sender.id} className="flex items-center gap-4 p-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{sender.name}</p>
                        <p className="text-sm text-muted-foreground truncate">
                          {[sender.addressLine1, sender.houseNumber, sender.postalCode, sender.city, sender.countryCode]
                            .filter(Boolean)
                            .join(' ')}
                        </p>
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <span>{copy.colDefault}</span>
                        <Switch
                          checked={sender.isDefault}
                          disabled={!canManage || update.isPending}
                          onCheckedChange={(checked) => {
                            if (!checked) return;
                            update.mutate({ senders: [{ id: sender.id, enabled: true, isDefault: true }] });
                          }}
                        />
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <span>{copy.colEnabled}</span>
                        <Switch
                          checked={sender.enabled}
                          disabled={!canManage || update.isPending}
                          onCheckedChange={(enabled) =>
                            update.mutate({ senders: [{ id: sender.id, enabled }] })
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="text-base font-semibold">{copy.parcelTypes}</h3>
                <p className="text-sm text-muted-foreground">{copy.parcelTypesHelp}</p>
              </div>
              {(settings?.methods.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">{copy.emptyMethods}</p>
              ) : (
                <div className="border rounded-lg divide-y">
                  {settings?.methods.map((method) => (
                    <div key={method.code} className="flex items-center gap-4 p-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{method.name}</p>
                        <p className="text-sm text-muted-foreground truncate">
                          {method.carrierName || method.carrierCode} · {method.code}
                        </p>
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <span>{copy.colDefault}</span>
                        <Switch
                          checked={method.isDefault}
                          disabled={!canManage || update.isPending}
                          onCheckedChange={(checked) => {
                            if (!checked) return;
                            update.mutate({ methods: [{ code: method.code, enabled: true, isDefault: true }] });
                          }}
                        />
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <span>{copy.colEnabled}</span>
                        <Switch
                          checked={method.enabled}
                          disabled={!canManage || update.isPending}
                          onCheckedChange={(enabled) =>
                            update.mutate({ methods: [{ code: method.code, enabled }] })
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </IntegrationDetailLayout>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={shared.disconnectConfirmTitle.replace('{integration}', copy.title)}
        description={shared.disconnectConfirmDescription}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => {
              setConfirmDisconnect(false);
              toast.success(shared.messages.disconnected.replace('{integration}', copy.title));
            },
            onError: () => toast.error(shared.messages.disconnectFailed.replace('{integration}', copy.title)),
          })
        }
      />
    </>
  );
}
