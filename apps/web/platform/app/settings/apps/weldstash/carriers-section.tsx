/**
 * Settings > Apps > WeldStash > Carriers: the PostNL and DHL Parcel accounts
 * that create labels. Served by the Rust backend only (`stash-shipping`).
 */

import { useState } from 'react';
import { CheckCircle2, Pencil, Plug, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { CarrierAccount } from '@weldsuite/app-api-client/schemas/shipping';
import {
  useCarrierCatalog,
  useCarriers,
  useDeleteCarrier,
  useTestCarrier,
  useUpdateCarrier,
} from '@/hooks/queries/use-shipping-queries';
import { isFeatureAvailable } from '@/lib/edition';
import { getTranslations } from '@/lib/i18n';
import { ShippingErrorNotice } from '@/app/weldstash/shipping/components/shipping-error-notice';
import { CarrierDialog } from './carrier-dialog';

/** The masked credentials in one line, such as `apiKey ••••abcd`. */
function maskedCredentials(carrier: CarrierAccount): string {
  return Object.entries(carrier.credentials)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key} ${value}`)
    .join(' · ');
}

/** The credentials column: nothing to show on WeldSuite's contract. */
function credentialsText(carrier: CarrierAccount, noCredentials: string): string {
  if (carrier.contract === 'weldsuite') return '—';
  return carrier.hasCredentials ? maskedCredentials(carrier) : noCredentials;
}

/** The carrier accounts table's columns. */
function carrierColumns(): ListTableColumn<CarrierAccount>[] {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.carriers;
  return [
    {
      id: 'carrier',
      header: t.colCarrier,
      width: 'w-[130px]',
      cell: (row) => <span className="font-medium">{row.carrierName}</span>,
    },
    { id: 'name', header: t.colName, cell: (row) => <span className="truncate">{row.name}</span> },
    {
      id: 'contract',
      header: t.colContract,
      width: 'w-[160px]',
      cell: (row) => <SoftBadge tone={row.contract === 'weldsuite' ? 'success' : 'neutral'}>{ts.contracts[row.contract]}</SoftBadge>,
    },
    {
      id: 'status',
      header: t.colStatus,
      width: 'w-[210px]',
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.isDefault ? <SoftBadge tone="success">{t.default}</SoftBadge> : null}
          <SoftBadge tone={row.isActive ? 'neutral' : 'warning'}>{row.isActive ? t.active : t.inactive}</SoftBadge>
          {row.settings.sandbox ? <SoftBadge tone="warning">{t.sandbox}</SoftBadge> : null}
        </span>
      ),
    },
    {
      id: 'credentials',
      header: t.colCredentials,
      width: 'w-[220px]',
      cell: (row) => (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {credentialsText(row, t.noCredentials)}
        </span>
      ),
    },
  ];
}

export function CarriersSection() {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.carriers;
  const { can } = usePermissions();
  const canRead = can('weldstash:carriers:read');
  const canCreate = can('weldstash:carriers:create');
  const canUpdate = can('weldstash:carriers:update');
  const canDelete = can('weldstash:carriers:delete');

  const carriers = useCarriers(canRead);
  const catalog = useCarrierCatalog(canRead);
  const update = useUpdateCarrier();
  const test = useTestCarrier();
  const remove = useDeleteCarrier();
  const [dialog, setDialog] = useState<{ carrier?: CarrierAccount } | null>(null);
  const [deleting, setDeleting] = useState<CarrierAccount | null>(null);
  const [testError, setTestError] = useState<unknown>(null);

  if (!isFeatureAvailable('stash-shipping') || !canRead) return null;

  const rows = carriers.data ?? [];

  const runTest = (carrier: CarrierAccount) => {
    setTestError(null);
    test.mutate(carrier.id, {
      onSuccess: (result) => (result.ok ? toast.success(t.testOk) : toast.error(t.testFailed)),
      onError: (err) => {
        setTestError(err);
        toast.error(t.testFailed);
      },
    });
  };

  const makeDefault = (carrier: CarrierAccount) =>
    update.mutate(
      { id: carrier.id, data: { isDefault: true } },
      {
        onSuccess: () => toast.success(t.defaultSet),
        onError: (err) => toast.error((err as Error).message || t.actionFailed),
      },
    );

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(t.deleted);
      setDeleting(null);
    } catch (err) {
      toast.error((err as Error).message || t.actionFailed);
    }
  };

  const columns = carrierColumns();

  return (
    <SectionCard
      title={t.title}
      description={t.description}
      action={
        canCreate ? (
          <Button size="sm" variant="outline" onClick={() => setDialog({})} disabled={!catalog.data}>
            <Plug className="mr-1 size-4" aria-hidden="true" />
            {t.connect}
          </Button>
        ) : undefined
      }
    >
      {carriers.isLoading && <InlineSpinner className="py-6" />}
      {carriers.isError && <ErrorState message={(carriers.error as Error)?.message || t.loadError} onRetry={() => void carriers.refetch()} />}
      {carriers.data && rows.length === 0 && (
        <div className="space-y-1 py-2">
          <EmptyText className="font-medium">{t.empty}</EmptyText>
          <EmptyText>{t.emptyDescription}</EmptyText>
        </div>
      )}
      {rows.length > 0 && (
        <ListTable<CarrierAccount>
          columns={columns}
          data={rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => t.actions.replace('{name}', row.name)}
          dense
          actions={[
            { id: 'edit', label: t.edit, icon: Pencil, hidden: () => !canUpdate, onClick: (row) => setDialog({ carrier: row }) },
            { id: 'test', label: t.test, icon: CheckCircle2, disabled: () => test.isPending, hidden: (row) => row.contract === 'weldsuite' || !canUpdate, onClick: runTest },
            { id: 'default', label: t.setDefault, icon: Star, hidden: (row) => row.isDefault || !row.isActive || !canUpdate, onClick: makeDefault },
            { id: 'delete', label: t.delete, icon: Trash2, variant: 'destructive', hidden: () => !canDelete, onClick: (row) => setDeleting(row) },
          ]}
        />
      )}
      {testError ? <div className="mt-3"><ShippingErrorNotice error={testError} title={t.testFailed} /></div> : null}
      {dialog && catalog.data ? (
        <CarrierDialog open onOpenChange={(open) => !open && setDialog(null)} catalog={catalog.data} carrier={dialog.carrier} />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.deleteTitle}
        description={t.deleteDescription.replace('{name}', deleting?.name ?? '')}
        confirmLabel={t.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={doDelete}
      />
    </SectionCard>
  );
}
