import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useDisconnectPayrollConnection,
  useSetPayrollConnectionMapping,
  useSyncPayrollConnection,
} from '@/hooks/queries/use-weldbooks-assets-queries';
import type { AccountMapping, GustoSyncResult, PayrollConnection } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { errorMessage, fill } from '../../fixed-assets/text';
import { CategoryMapping } from './category-mapping';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function MappingDialog({ connection, open, onOpenChange }: Readonly<{ connection: PayrollConnection; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const tg = t.weldbooksUs.assets.payroll.gusto.mapping;
  const common = t.weldbooksUs.assets.common;
  const save = useSetPayrollConnectionMapping();
  const [mapping, setMapping] = useState<AccountMapping>((connection.accountMapping ?? {}) as AccountMapping);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync({ id: connection.id, accountMapping: mapping });
      toast.success(tg.saved);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (save.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{tg.title}</DialogTitle>
          <DialogDescription>{tg.description}</DialogDescription>
        </DialogHeader>
        <CategoryMapping idPrefix={`gusto-${connection.id}`} value={mapping} onChange={setMapping} />
        {!mapping.net_pay ? (
          <p className="text-sm text-muted-foreground" data-testid="mapping-needs-net-pay">
            {tg.needNetPay}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {common.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={save.isPending} data-testid="mapping-save">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SyncDialog({ connection, open, onOpenChange }: Readonly<{ connection: PayrollConnection; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const ts = t.weldbooksUs.assets.payroll.gusto.sync;
  const common = t.weldbooksUs.assets.common;
  const { formatDate } = useWeldbooksFormat();
  const sync = useSyncPayrollConnection();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<GustoSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const datesValid = (from === '' || ISO_DATE.test(from)) && (to === '' || ISO_DATE.test(to)) && !(from && to && from > to);

  const submit = async () => {
    setError(null);
    try {
      const outcome = await sync.mutateAsync({
        id: connection.id,
        input: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      });
      setResult(outcome);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (sync.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{ts.title}</DialogTitle>
          <DialogDescription>{ts.description}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 text-sm" data-testid="sync-result">
            <p className="font-medium">{fill(ts.window, { from: formatDate(result.from), to: formatDate(result.to) })}</p>
            <dl className="grid grid-cols-3 gap-3">
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">{ts.fetched}</dt>
                <dd className="text-lg font-semibold tabular-nums">{result.fetched}</dd>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">{ts.imported}</dt>
                <dd className="text-lg font-semibold tabular-nums" data-testid="sync-imported">{result.imported.length}</dd>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">{ts.skipped}</dt>
                <dd className="text-lg font-semibold tabular-nums">{result.skipped.length}</dd>
              </div>
            </dl>
            {result.imported.length > 0 ? (
              <ul className="space-y-1">
                {result.imported.map((item) => (
                  <li key={item.importId}>
                    <Link to="/weldbooks/payroll/$id" params={{ id: item.importId }} className="underline-offset-2 hover:underline">
                      {formatDate(item.payDate)}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {result.skipped.length > 0 ? (
              <div className="space-y-1">
                <p className="font-medium">{ts.skippedTitle}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {result.skipped.map((item, index) => (
                    <li key={`${item.externalId ?? index}-${index}`}>
                      {item.payDate ? `${formatDate(item.payDate)}: ` : ''}
                      {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {result.failed.length > 0 ? (
              <div className="space-y-1">
                <p className="flex items-center gap-1.5 font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  {ts.failedTitle}
                </p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {result.failed.map((item) => (
                    <li key={item.externalId}>
                      {formatDate(item.payDate)}: {item.error}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sync-from">{ts.from}</Label>
                <Input id="sync-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sync-to">{ts.to}</Label>
                <Input id="sync-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{ts.defaultWindow}</p>
            {!datesValid ? (
              <p className="text-sm text-destructive" role="alert">
                {ts.invalidDates}
              </p>
            ) : null}
            {error ? (
              <p className="text-sm text-destructive" role="alert" data-testid="sync-error">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              {common.close}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sync.isPending}>
                {common.cancel}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!datesValid || sync.isPending} data-testid="sync-submit">
                {sync.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                {sync.isPending ? ts.syncing : ts.run}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A connected Gusto company: status, the account mapping, a sync and the disconnect. The access token is never shown. */
export interface ConnectionPermissions {
  map: boolean;
  sync: boolean;
  disconnect: boolean;
}

export function GustoConnectionCard({ connection, can }: Readonly<{ connection: PayrollConnection; can: ConnectionPermissions }>) {
  const { t } = useI18n();
  const tg = t.weldbooksUs.assets.payroll.gusto;
  const common = t.weldbooksUs.assets.common;
  const { formatDateTime } = useWeldbooksFormat();
  const disconnect = useDisconnectPayrollConnection();
  const [dialog, setDialog] = useState<'mapping' | 'sync' | 'disconnect' | null>(null);
  const mapped = Boolean(connection.accountMapping?.net_pay);

  const confirmDisconnect = async () => {
    try {
      await disconnect.mutateAsync(connection.id);
      toast.success(tg.disconnected);
      setDialog(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card data-testid={`gusto-connection-${connection.id}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">
            {tg.company} {connection.providerCompanyId}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={connection.status === 'active' ? 'success' : connection.status === 'error' ? 'destructive' : 'secondary'}>
              {tg.statuses[connection.status]}
            </Badge>
            {connection.environment ? <Badge variant="outline">{tg.connect.environments[connection.environment]}</Badge> : null}
            {connection.hasCredentials ? <span className="text-xs text-muted-foreground">{tg.tokenStored}</span> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {connection.lastSyncedAt ? fill(tg.lastSynced, { date: formatDateTime(connection.lastSyncedAt) }) : tg.neverSynced}
        </p>
        {connection.lastError ? (
          <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {connection.lastError}
          </p>
        ) : null}
        {!mapped ? <p className="text-sm text-muted-foreground">{tg.mapFirst}</p> : null}
        <div className="flex flex-wrap gap-2">
          {can.map ? (
            <Button variant="outline" size="sm" onClick={() => setDialog('mapping')}>
              {tg.mapping.open}
            </Button>
          ) : null}
          {can.sync ? (
            <Button size="sm" onClick={() => setDialog('sync')} disabled={!mapped} data-testid="sync-open">
              <RefreshCw className="h-4 w-4" />
              {tg.sync.open}
            </Button>
          ) : null}
          {can.disconnect ? (
            <Button variant="ghost" size="sm" onClick={() => setDialog('disconnect')}>
              {tg.disconnect.open}
            </Button>
          ) : null}
        </div>
      </CardContent>

      {dialog === 'mapping' ? <MappingDialog connection={connection} open onOpenChange={(open) => setDialog(open ? 'mapping' : null)} /> : null}
      {dialog === 'sync' ? <SyncDialog connection={connection} open onOpenChange={(open) => setDialog(open ? 'sync' : null)} /> : null}
      <ConfirmDialog
        open={dialog === 'disconnect'}
        onOpenChange={(open) => setDialog(open ? 'disconnect' : null)}
        title={tg.disconnect.title}
        description={tg.disconnect.description}
        confirmLabel={tg.disconnect.confirm}
        cancelLabel={common.cancel}
        variant="destructive"
        onConfirm={confirmDisconnect}
      />
    </Card>
  );
}
