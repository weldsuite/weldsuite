'use client';

import { useMemo, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@/components/ui/switch';
import { getTranslations } from '@/lib/i18n';
import {
  useWeldAdsAuthorizeFacebook,
  useWeldAdsAccounts,
  useWeldAdsConnections,
  useUpdateWeldAdsAccount,
  useSyncWeldAdsConnection,
  useDeleteWeldAdsConnection,
} from '@/hooks/queries/use-weldads-queries';

export default function WeldAdsAccountsPage() {
  const t = getTranslations('weldads').module;
  const connections = useWeldAdsConnections();
  const accounts = useWeldAdsAccounts(connections.data?.[0]?.id);
  const authorize = useWeldAdsAuthorizeFacebook();
  const updateAccount = useUpdateWeldAdsAccount();
  const syncConnection = useSyncWeldAdsConnection();
  const deleteConnection = useDeleteWeldAdsConnection();
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);

  const connection = connections.data?.[0];

  const sortedAccounts = useMemo(
    () => [...(accounts.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts.data],
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t.accountsTitle}</h1>
          <p className="text-muted-foreground">{t.accountsDescription}</p>
        </div>
        <div className="flex gap-2">
          {connection ? (
            <>
              <Button
                variant="outline"
                disabled={syncConnection.isPending}
                onClick={() => syncConnection.mutate({ connectionId: connection.id })}
              >
                {syncConnection.isPending ? t.refreshing : t.refresh}
              </Button>
              <Button
                variant="destructive"
                disabled={deleteConnection.isPending}
                onClick={() => deleteConnection.mutate(connection.id)}
              >
                {t.disconnect}
              </Button>
            </>
          ) : (
            <Button
              disabled={authorize.isPending}
              onClick={async () => {
                const result = await authorize.mutateAsync();
                window.location.href = result.authorizeUrl;
              }}
            >
              {authorize.isPending ? t.connecting : t.connectFacebook}
            </Button>
          )}
        </div>
      </div>

      {!connection && <p className="text-muted-foreground">{t.noConnection}</p>}

      {connection && sortedAccounts.length === 0 && (
        <p className="text-muted-foreground">{t.noAccounts}</p>
      )}

      {connection && sortedAccounts.length > 0 && (
        <div className="rounded-lg border divide-y">
          {sortedAccounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between p-4 gap-4">
              <div>
                <div className="font-medium">{account.name}</div>
                <div className="text-sm text-muted-foreground">{account.platformAccountId}</div>
              </div>
              <Switch
                checked={account.isSelected}
                disabled={busyAccountId === account.id || updateAccount.isPending}
                onCheckedChange={async (checked) => {
                  setBusyAccountId(account.id);
                  try {
                    await updateAccount.mutateAsync({ id: account.id, isSelected: checked });
                  } finally {
                    setBusyAccountId(null);
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
