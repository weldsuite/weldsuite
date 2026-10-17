import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { RowChip } from '@/components/accounting/weldbooks-row-cells';
import { DealsIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { PageLoader } from '@/components/page-loader';
import {
  useDeleteSalesTaxZone,
  useSalesTaxJurisdictions,
  useSalesTaxZones,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { SalesTaxAgency, SalesTaxZone } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useSetupTexts } from '@/app/weldbooks/sales-tax/setup/setup-texts';
import { ZoneDialog } from '@/app/weldbooks/sales-tax/zones/zone-dialog';
import { formatCombinedRate } from '@/app/weldbooks/sales-tax/zones/zone-model';
import { countZips, summarizeZipList } from '@/app/weldbooks/sales-tax/zones/zip-list';
import { AgencyTabIntro, AgencyTabLoadError, rowMenuItems } from './agency-tab-parts';
import type { AgencyTabAccess } from './sales-tax-agency-model';

/** The tax zones of an agency: which jurisdictions apply together, for which ZIP codes. */
export function AgencyZonesTab({
  agency,
  access,
}: Readonly<{ agency: SalesTaxAgency; access: AgencyTabAccess }>) {
  const { t, format, plural } = useSetupTexts();
  const tz = t.zones;
  const zones = useSalesTaxZones(agency.id);
  const jurisdictions = useSalesTaxJurisdictions(agency.id);
  const remove = useDeleteSalesTaxZone();
  const [dialog, setDialog] = useState<{ zone?: SalesTaxZone } | null>(null);
  const [toDelete, setToDelete] = useState<SalesTaxZone | null>(null);

  const rows = useMemo(
    () => [...(zones.data ?? [])].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)),
    [zones.data],
  );
  const hasJurisdictions = (jurisdictions.data?.length ?? 0) > 0;

  let body: ReactNode;
  if (zones.isLoading || jurisdictions.isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (zones.isError) {
    body = <AgencyTabLoadError message={tz.loadError} retryLabel={t.common.retry} onRetry={() => void zones.refetch()} />;
  } else if (rows.length === 0) {
    body = (
      <TabEmptyState
        illustration={<DealsIllustration />}
        title={tz.emptyTitle}
        description={hasJurisdictions ? tz.emptyDescription : tz.needJurisdictions}
        action={access.canCreate && hasJurisdictions ? { label: tz.add, onClick: () => setDialog({}) } : undefined}
      />
    );
  } else {
    body = (
      <TabListScope>
        <div className="border-t border-gray-200/70 dark:border-border">
          {rows.map((zone) => {
            const zips = summarizeZipList(zone.postalCodes);
            return (
              <TabListRow
                key={zone.id}
                label={zone.name}
                onOpen={access.canUpdate ? () => setDialog({ zone }) : undefined}
                menuLabel={t.jurisdictions.columns.actions}
                menu={rowMenuItems({
                  canUpdate: access.canUpdate,
                  canDelete: access.canDelete,
                  editLabel: t.common.edit,
                  deleteLabel: t.common.delete,
                  onEdit: () => setDialog({ zone }),
                  onDelete: () => setToDelete(zone),
                })}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{zone.name}</span>
                    {zone.isOrigin ? <RowChip tone="blue">{tz.origin}</RowChip> : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {zone.jurisdictions.map((j) => j.name).join(', ')}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={plural(countZips(zone.postalCodes), tz.zipCount)}
                  >
                    {tz.columns.zips}: {zips.text || tz.noZips}
                    {zips.more > 0 ? ` ${format(tz.moreZips, { count: zips.more })}` : ''}
                  </div>
                </div>
                <span className="w-[72px] flex-shrink-0 text-right text-sm font-medium tabular-nums">
                  {formatCombinedRate(zone.combinedRate)}
                </span>
                <span className="w-[56px] flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground @max-[440px]:hidden">
                  {tz.columns.priority} {zone.priority}
                </span>
              </TabListRow>
            );
          })}
        </div>
      </TabListScope>
    );
  }

  return (
    <section aria-label={tz.title}>
      <AgencyTabIntro
        intro={
          <>
            <p>{tz.intro}</p>
            <p>{tz.fallback}</p>
          </>
        }
        addLabel={access.canCreate && rows.length > 0 ? tz.add : undefined}
        onAdd={() => setDialog({})}
      />

      {body}

      <ZoneDialog
        agency={agency}
        jurisdictions={jurisdictions.data ?? []}
        zone={dialog?.zone}
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={toDelete ? format(tz.deleteDialog.title, { name: toDelete.name }) : ''}
        description={tz.deleteDialog.description}
        confirmLabel={tz.deleteDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            await remove.mutateAsync(toDelete.id);
            toast.success(tz.deleted);
          } catch (err) {
            toast.error(err instanceof Error && err.message ? err.message : t.common.saveError);
          } finally {
            setToDelete(null);
          }
        }}
      />
    </section>
  );
}
