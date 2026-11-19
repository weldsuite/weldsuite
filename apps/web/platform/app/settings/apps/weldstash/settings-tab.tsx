/**
 * Replenishment settings (every `stash_settings` field) and the sales history
 * the forecast can use besides orders: the CSV imports.
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ReplenishmentSettings, SalesHistoryImport } from '@weldsuite/app-api-client/schemas/replenishment';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { InlineSpinner, PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { getLocale, getTranslations } from '@/lib/i18n';
import {
  useDeleteSalesHistoryImport,
  useReplenishmentSettings,
  useSalesHistoryImports,
  useUpdateReplenishmentSettings,
} from '@/hooks/queries/use-replenishment-queries';
import { useWeldstashWarehouses } from '@/hooks/queries/use-weldstash-queries';
import { formatDate } from '@/app/weldstash/lib/numbers';
import { formToSettingsInput, makeSettingsFormSchema, settingsToForm, type SettingsFormValues } from '@/app/weldstash/replenishment/lib/settings-form';
import { ImportWizard } from './import-wizard';

const DEFAULT_WAREHOUSE = '__default__';

export function SettingsTab() {
  const t = getTranslations('weldstashReplenishment').settings;
  const settings = useReplenishmentSettings();

  if (settings.isLoading) return <PageLoader fullScreen={false} />;
  if (settings.isError || !settings.data) {
    return (
      <div className="p-6">
        <ErrorState message={(settings.error as Error)?.message || t.loadError} onRetry={() => void settings.refetch()} />
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <SettingsForm settings={settings.data} />
      <ImportsSection settings={settings.data} />
    </div>
  );
}

function SettingsForm({ settings }: Readonly<{ settings: ReplenishmentSettings }>) {
  const t = getTranslations('weldstashReplenishment').settings;
  const { can } = usePermissions();
  const canManage = can('inventory:manage');
  const update = useUpdateReplenishmentSettings();
  const warehouses = useWeldstashWarehouses({ limit: 100 });

  const schema = useMemo(() => makeSettingsFormSchema(t.invalid), [t]);
  const form = useForm<SettingsFormValues>({ resolver: zodResolver(schema), defaultValues: settingsToForm(settings) });

  // The server's copy (after a save, or a cut-over date suggested by an import) replaces the form.
  const version = `${settings.updatedAt ?? ''}|${settings.historyCutoverDate ?? ''}|${settings.replenishmentEnabled}`;
  useEffect(() => {
    form.reset(settingsToForm(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const onSubmit = async (values: SettingsFormValues) => {
    const result = formToSettingsInput(values);
    if (!result.ok) return;
    try {
      await update.mutateAsync(result.input);
      toast.success(t.toastSaved);
    } catch (err) {
      toast.error((err as Error).message || t.saveFailed);
    }
  };

  const numberField = (name: 'serviceLevelPct' | 'reviewPeriodDays' | 'lookbackDays' | 'defaultLeadTimeDays', label: string, hint: string, unit: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <div className="flex items-center gap-2">
            <FormControl>
              <Input inputMode="decimal" className="w-28" disabled={!canManage} {...field} />
            </FormControl>
            <span className="text-sm text-muted-foreground">{unit}</span>
          </div>
          <FormDescription>{hint}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <SectionCard title={t.title} description={t.description}>
          <div className="space-y-5">
            <FormField
              control={form.control}
              name="replenishmentEnabled"
              render={({ field }) => (
                <FormItem className="flex items-start justify-between gap-4 rounded-md border p-3">
                  <div className="space-y-1">
                    <FormLabel>{t.enabled}</FormLabel>
                    <FormDescription>{t.enabledHint}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!canManage} />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-2">
              {numberField('serviceLevelPct', t.serviceLevel, t.serviceLevelHint, '%')}
              {numberField('reviewPeriodDays', t.reviewPeriod, t.reviewPeriodHint, t.daysUnit)}
              {numberField('lookbackDays', t.lookback, t.lookbackHint, t.daysUnit)}
              {numberField('defaultLeadTimeDays', t.leadTime, t.leadTimeHint, t.daysUnit)}
            </div>

            <FormField
              control={form.control}
              name="demandWarehouseId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.demandWarehouse}</FormLabel>
                  <Select
                    value={field.value || DEFAULT_WAREHOUSE}
                    onValueChange={(value) => field.onChange(value === DEFAULT_WAREHOUSE ? '' : value)}
                    disabled={!canManage}
                  >
                    <FormControl>
                      <SelectTrigger className="max-w-sm">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={DEFAULT_WAREHOUSE}>{t.defaultWarehouse}</SelectItem>
                      {(warehouses.data?.data ?? []).map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{t.demandWarehouseHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="historyCutoverDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.cutover}</FormLabel>
                    <FormControl>
                      <Input type="date" className="w-44" disabled={!canManage} {...field} />
                    </FormControl>
                    <FormDescription>{t.cutoverHint}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="runHourUtc"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.runHour}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={!canManage}>
                      <FormControl>
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, hour) => (
                          <SelectItem key={hour} value={String(hour)}>
                            {t.hourUtc.replace('{hour}', String(hour).padStart(2, '0'))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>{t.runHourHint}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {canManage ? (
              <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
                {update.isPending ? t.saving : t.save}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">{t.readOnly}</p>
            )}
          </div>
        </SectionCard>
      </form>
    </Form>
  );
}

function ImportsSection({ settings }: Readonly<{ settings: ReplenishmentSettings }>) {
  const t = getTranslations('weldstashReplenishment').imports;
  const locale = getLocale();
  const { can } = usePermissions();
  const canManage = can('inventory:manage');
  const imports = useSalesHistoryImports();
  const remove = useDeleteSalesHistoryImport();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [deleting, setDeleting] = useState<SalesHistoryImport | null>(null);

  const columns: ListTableColumn<SalesHistoryImport>[] = [
    { id: 'file', header: t.columns.file, cell: (row) => <span className="font-medium">{row.fileName}</span> },
    {
      id: 'status',
      header: t.columns.status,
      width: 'w-[110px]',
      cell: (row) => (
        <SoftBadge tone={row.status === 'done' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'}>
          {(t.statuses as Record<string, string>)[row.status] ?? row.status}
        </SoftBadge>
      ),
    },
    {
      id: 'rows',
      header: t.columns.rows,
      width: 'w-[150px]',
      align: 'right',
      accessor: (row) => t.rowsSummary.replace('{imported}', String(row.rowsImported)).replace('{skipped}', String(row.rowsSkipped)),
    },
    {
      id: 'range',
      header: t.columns.range,
      width: 'w-[210px]',
      accessor: (row) => (row.dateFrom && row.dateTo ? `${formatDate(row.dateFrom, locale)} – ${formatDate(row.dateTo, locale)}` : ''),
    },
    { id: 'uploaded', header: t.columns.uploaded, width: 'w-[120px]', accessor: (row) => formatDate(row.createdAt, locale) },
  ];

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(t.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message || t.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  const rows = imports.data ?? [];

  return (
    <SectionCard
      title={t.title}
      description={t.description}
      action={
        canManage ? (
          <Button size="sm" variant="outline" onClick={() => setWizardOpen(true)}>
            <Upload className="mr-1 size-4" />
            {t.import}
          </Button>
        ) : undefined
      }
    >
      {imports.isLoading && <InlineSpinner className="py-6" />}
      {imports.isError && <ErrorState message={(imports.error as Error)?.message || t.loadError} onRetry={() => void imports.refetch()} />}
      {imports.data && rows.length === 0 && <EmptyText>{t.empty}</EmptyText>}
      {rows.length > 0 && (
        <ListTable<SalesHistoryImport>
          columns={columns}
          data={rows}
          rowKey={(row) => row.id}
          dense
          actions={
            canManage
              ? [{ id: 'delete', label: t.delete, icon: Trash2, variant: 'destructive', onClick: (row) => setDeleting(row) }]
              : undefined
          }
        />
      )}
      {wizardOpen && <ImportWizard open={wizardOpen} onOpenChange={setWizardOpen} settings={settings} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.deleteTitle}
        description={t.deleteDescription.replace('{file}', deleting?.fileName ?? '')}
        confirmLabel={t.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={handleDelete}
      />
    </SectionCard>
  );
}
