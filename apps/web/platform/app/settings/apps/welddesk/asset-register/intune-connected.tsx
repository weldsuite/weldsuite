import { useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  ASSET_SOURCE_MAX_INTERVAL_HOURS,
  ASSET_SOURCE_MIN_INTERVAL_HOURS,
  type AssetSource,
  type AssetSourceRunStatus,
  type AssetSourceTestResult,
} from '@weldsuite/core-api-client/schemas/asset-sources';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Label } from '@weldsuite/ui/components/label';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  useDeleteAssetSource,
  useSyncAssetSource,
  useTestAssetSource,
  useUpdateAssetSource,
} from '@/hooks/queries/use-asset-source-queries';
import { useI18n } from '@/lib/i18n/provider';
import { apiErrorInfo, assetSourceErrorText } from './asset-source-errors';

const INTERVAL_PRESETS = [1, 6, 12, 24, 48, 72, 168];

const STATUS_TONE: Record<AssetSourceRunStatus | 'never', SoftTone> = {
  running: 'warning',
  ok: 'success',
  failed: 'danger',
  never: 'neutral',
};

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return format(date, date.getFullYear() === new Date().getFullYear() ? 'MMM d, h:mm a' : 'MMM d, yyyy, h:mm a');
}

/** The connected source: status, the last import, progress, schedule, sync by hand, secret and disconnect. */
export function IntuneConnected({ source }: Readonly<{ source: AssetSource }>) {
  const { t } = useI18n();
  const ti = t.assetSources.intune;
  const update = useUpdateAssetSource();
  const sync = useSyncAssetSource();
  const remove = useDeleteAssetSource();

  const [secretOpen, setSecretOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const running = source.lastStatus === 'running';
  const statusKey = source.lastStatus ?? 'never';

  const startSync = async () => {
    try {
      await sync.mutateAsync(source.id);
      toast.success(ti.syncStarted);
    } catch (err) {
      toast.error(apiErrorInfo(err).code === 'already_running' ? ti.alreadyRunning : ti.syncFailed);
    }
  };

  const saveSchedule = async (input: { enabled?: boolean; intervalHours?: number }) => {
    try {
      await update.mutateAsync({ id: source.id, input });
      toast.success(ti.schedule.saved);
    } catch {
      toast.error(ti.schedule.saveFailed);
    }
  };

  const disconnect = async () => {
    try {
      await remove.mutateAsync(source.id);
      toast.success(ti.disconnect.done);
      setConfirmOpen(false);
    } catch {
      toast.error(ti.disconnect.failed);
    }
  };

  const intervals = INTERVAL_PRESETS.includes(source.intervalHours)
    ? INTERVAL_PRESETS
    : [...INTERVAL_PRESETS, source.intervalHours].sort((a, b) => a - b);
  const intervalLabel = (hours: number) => (hours === 1 ? ti.schedule.everyHour : ti.schedule.everyHours.replace('{hours}', String(hours)));

  const stats = source.lastStats;
  const lastImport = formatTime(source.lastSyncAt);

  return (
    <SectionCard
      title={source.name}
      description={ti.description}
      action={
        <SoftBadge tone={STATUS_TONE[statusKey]} data-testid="intune-status">
          {ti.status[statusKey]}
        </SoftBadge>
      }
      contentClassName="space-y-5"
    >
      {source.lastStatus === 'failed' && source.lastError && (
        <InfoBanner variant="danger" title={ti.lastErrorTitle} data-testid="intune-last-error">
          {assetSourceErrorText(ti.errors, source.lastErrorCode, source.lastError)}
        </InfoBanner>
      )}

      {running && (
        <div className="flex items-center gap-2 text-sm" role="status" data-testid="intune-progress">
          <InlineSpinner />
          <span>{ti.progress.replace('{count}', String(source.progress?.stats.total ?? 0))}</span>
        </div>
      )}

      <FieldGrid
        fields={[
          { label: ti.lastImport, value: lastImport ?? ti.neverImported },
          { label: ti.nextImport, value: source.enabled ? (formatTime(source.nextSyncAt) ?? '—') : ti.scheduleOff },
          { label: ti.form.tenantId, value: source.config.tenantId },
          { label: ti.form.clientId, value: source.config.clientId },
        ]}
      />

      {stats && (
        <FieldGrid
          className="sm:grid-cols-5"
          fields={[
            { label: ti.stats.total, value: String(stats.total) },
            { label: ti.stats.created, value: String(stats.created) },
            { label: ti.stats.updated, value: String(stats.updated) },
            { label: ti.stats.unchanged, value: String(stats.unchanged) },
            { label: ti.stats.failed, value: String(stats.failed) },
          ]}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void startSync()} disabled={running || sync.isPending} data-testid="intune-sync-now">
          {sync.isPending ? ti.syncStarting : ti.syncNow}
        </Button>
        <Button variant="outline" onClick={() => setSecretOpen(true)}>
          {ti.secretDialog.open}
        </Button>
        <Button variant="outline" onClick={() => setConfirmOpen(true)} data-testid="intune-disconnect">
          {ti.disconnect.action}
        </Button>
      </div>

      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between gap-6">
          <div className="space-y-1">
            <p className="text-sm font-medium">{ti.schedule.title}</p>
            <p className="text-sm text-muted-foreground">{ti.schedule.description}</p>
          </div>
          <Switch
            checked={source.enabled}
            onCheckedChange={(enabled) => void saveSchedule({ enabled })}
            disabled={update.isPending}
            aria-label={ti.schedule.title}
          />
        </div>
        {source.enabled && (
          <div className="flex items-center gap-3">
            <Label htmlFor="intune-interval" className="text-sm">
              {ti.schedule.interval}
            </Label>
            <Select
              value={String(source.intervalHours)}
              onValueChange={(value) => void saveSchedule({ intervalHours: Number(value) })}
              disabled={update.isPending}
            >
              <SelectTrigger id="intune-interval" className="w-48" aria-label={ti.schedule.interval}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intervals
                  .filter((hours) => hours >= ASSET_SOURCE_MIN_INTERVAL_HOURS && hours <= ASSET_SOURCE_MAX_INTERVAL_HOURS)
                  .map((hours) => (
                    <SelectItem key={hours} value={String(hours)}>
                      {intervalLabel(hours)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{ti.howItWorks}</p>

      <ReplaceSecretDialog source={source} open={secretOpen} onOpenChange={setSecretOpen} />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={ti.disconnect.title}
        description={ti.disconnect.description}
        confirmLabel={ti.disconnect.confirm}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={disconnect}
      />
    </SectionCard>
  );
}

function ReplaceSecretDialog({
  source,
  open,
  onOpenChange,
}: Readonly<{ source: AssetSource; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const ti = t.assetSources.intune;
  const td = ti.secretDialog;
  const update = useUpdateAssetSource();
  const test = useTestAssetSource();
  const [secret, setSecret] = useState('');
  const [result, setResult] = useState<AssetSourceTestResult | null>(null);
  const [failed, setFailed] = useState(false);

  const close = (next: boolean) => {
    if (!next) {
      setSecret('');
      setResult(null);
      setFailed(false);
    }
    onOpenChange(next);
  };

  const runTest = async () => {
    setFailed(false);
    try {
      setResult(await test.mutateAsync({ id: source.id, input: { secret: secret.trim() } }));
    } catch {
      setResult(null);
      setFailed(true);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await update.mutateAsync({ id: source.id, input: { secret: secret.trim() } });
      toast.success(td.saved);
      close(false);
    } catch {
      toast.error(td.saveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{td.title}</DialogTitle>
          <DialogDescription>{td.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="intune-new-secret">{ti.form.secret}</Label>
            <Input
              id="intune-new-secret"
              type="password"
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
                setResult(null);
              }}
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">{ti.form.secretHelp}</p>
          </div>
          {result?.ok === true && <InfoBanner variant="success">{td.testOk}</InfoBanner>}
          {result?.ok === false && <InfoBanner variant="danger">{assetSourceErrorText(ti.errors, result.code, result.message)}</InfoBanner>}
          {failed && <InfoBanner variant="danger">{ti.form.testFailed}</InfoBanner>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              {td.cancel}
            </Button>
            <Button type="button" variant="outline" disabled={secret.trim() === '' || test.isPending} onClick={() => void runTest()}>
              {test.isPending ? ti.form.testing : td.test}
            </Button>
            <Button type="submit" disabled={secret.trim() === '' || update.isPending}>
              {update.isPending ? td.saving : td.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
