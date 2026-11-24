import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SettingRow, SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { usePermissions } from '@weldsuite/permissions/react';
import type { WeldPassDevice } from '@weldsuite/app-api-client/domains/weldpass-devices';
import {
  useRevokeWeldPassDevice,
  useUpdateWeldPassSettings,
  useWeldPassDevices,
  useWeldPassSettings,
} from '@/hooks/queries/use-weldpass-devices-queries';
import { useI18n } from '@/lib/i18n/provider';
import { TimeAgo, errorMessage } from '@/app/weldpass/components/shared';

function OfflineCopySetting() {
  const { t } = useI18n();
  const to = t.settings.weldpass.offline;
  const { can } = usePermissions();
  const canManage = can('passwords:manage');
  const { data, isLoading, isError, refetch } = useWeldPassSettings();
  const update = useUpdateWeldPassSettings();

  if (isLoading) return <InlineSpinner />;
  if (isError || !data) return <ErrorState message={to.loadFailed} onRetry={() => void refetch()} />;

  const save = (offlineCopies: boolean) => {
    update.mutate(offlineCopies, {
      onSuccess: () => toast.success(to.saved),
      onError: (error) => toast.error(errorMessage(error, to.saveFailed)),
    });
  };

  return (
    <SettingsSection title={to.title}>
      <SettingRow
        label={to.switchLabel}
        description={canManage ? to.switchDescription : `${to.switchDescription} ${to.readOnlyHint}`}
        htmlFor="weldpass-offline-copies"
        descriptionId="weldpass-offline-copies-description"
      >
        <Switch
          id="weldpass-offline-copies"
          checked={data.offlineCopies}
          onCheckedChange={save}
          disabled={!canManage || update.isPending}
          aria-describedby="weldpass-offline-copies-description"
        />
      </SettingRow>
    </SettingsSection>
  );
}

function DevicesSection() {
  const { t } = useI18n();
  const td = t.settings.weldpass.devices;
  const { can } = usePermissions();
  // Managers see every phone in the workspace and who owns it; everyone else their own.
  const canManage = can('passwords:manage');
  const { data: devices, isLoading, isError, refetch } = useWeldPassDevices(canManage);
  const revoke = useRevokeWeldPassDevice();
  const [revoking, setRevoking] = useState<WeldPassDevice | null>(null);

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await revoke.mutateAsync(revoking.id);
      toast.success(td.revoked);
      setRevoking(null);
    } catch (error) {
      toast.error(errorMessage(error, td.revokeFailed));
    }
  };

  return (
    <SettingsSection title={td.title} description={canManage ? td.descriptionAll : td.descriptionOwn}>
      {isLoading && <InlineSpinner />}
      {!isLoading && (isError || !devices) && <ErrorState message={td.loadFailed} onRetry={() => void refetch()} />}
      {devices && devices.length === 0 && <EmptyState icon={Smartphone} title={td.empty} />}
      {devices && devices.length > 0 && (
        // A focusable, named region, so the table scrolls by keyboard on a narrow screen.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div role="region" tabIndex={0} aria-labelledby="weldpass-devices-caption" className="rounded-md border">
          <Table>
            <caption id="weldpass-devices-caption" className="sr-only">
              {td.caption}
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{td.name}</TableHead>
                {canManage && <TableHead scope="col">{td.owner}</TableHead>}
                <TableHead scope="col">{td.platform}</TableHead>
                <TableHead scope="col">{td.appVersion}</TableHead>
                <TableHead scope="col">{td.added}</TableHead>
                <TableHead scope="col">{td.lastSync}</TableHead>
                <TableHead scope="col">{td.status}</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">{td.revoke}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((device) => {
                const active = !device.revokedAt;
                return (
                  <TableRow key={device.id}>
                    <TableHead scope="row" className="whitespace-nowrap font-medium">
                      {device.name}
                    </TableHead>
                    {canManage && (
                      <TableCell className="whitespace-nowrap">
                        {device.userName || device.userEmail || device.userId}
                      </TableCell>
                    )}
                    <TableCell>{td.platforms[device.platform]}</TableCell>
                    <TableCell>{device.appVersion ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <TimeAgo value={device.createdAt} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {device.lastSyncAt ? <TimeAgo value={device.lastSyncAt} /> : td.neverSynced}
                    </TableCell>
                    <TableCell>
                      <SoftBadge tone={active ? 'success' : 'neutral'}>
                        {active ? td.statusActive : td.statusRevoked}
                      </SoftBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      {active && (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={td.revokeLabel.replace('{name}', device.name)}
                          onClick={() => setRevoking(device)}
                        >
                          {td.revoke}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={td.revokeTitle.replace('{name}', revoking?.name ?? '')}
        description={td.revokeDescription}
        confirmLabel={td.revoke}
        variant="destructive"
        onConfirm={confirmRevoke}
      />
    </SettingsSection>
  );
}

/**
 * Settings → Apps → WeldPass: whether phones may keep an encrypted offline
 * copy of the vaults, and the phones that do (ADR PASS-010, Rust backend
 * only: the page is hidden on Global).
 */
export default function WeldPassSettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.weldpass;

  return (
    // `min-w-0`: never wider than the settings column, so the device table scrolls inside it.
    <div className="min-w-0 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>
      <OfflineCopySetting />
      <DevicesSection />
    </div>
  );
}
