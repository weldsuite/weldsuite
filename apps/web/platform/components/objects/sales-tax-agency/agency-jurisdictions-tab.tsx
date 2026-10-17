import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { RowChip } from '@/components/accounting/weldbooks-row-cells';
import { CompaniesIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { PageLoader } from '@/components/page-loader';
import {
  useDeleteSalesTaxJurisdiction,
  useDeleteSalesTaxRate,
  useSalesTaxJurisdictions,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type {
  JurisdictionRate,
  SalesTaxAgency,
  SalesTaxJurisdiction,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { formatRatePercent } from '@/app/weldbooks/sales-tax/setup/format';
import { useSetupTexts } from '@/app/weldbooks/sales-tax/setup/setup-texts';
import { JurisdictionDialog } from '@/app/weldbooks/sales-tax/rates/jurisdiction-dialog';
import { RateDialog } from '@/app/weldbooks/sales-tax/rates/rate-dialog';
import { sortJurisdictions } from '@/app/weldbooks/sales-tax/rates/rate-model';
import { AgencyRateHistory } from './agency-rate-history';
import { AgencyTabIntro, AgencyTabLoadError, rowMenuItems } from './agency-tab-parts';
import type { AgencyTabAccess } from './sales-tax-agency-model';

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The jurisdictions of an agency with their rate history, and the dialogs to change them. */
export function AgencyJurisdictionsTab({
  agency,
  access,
}: Readonly<{ agency: SalesTaxAgency; access: AgencyTabAccess }>) {
  const { t, format } = useSetupTexts();
  const tj = t.jurisdictions;
  const query = useSalesTaxJurisdictions(agency.id);
  const removeJurisdiction = useDeleteSalesTaxJurisdiction();
  const removeRate = useDeleteSalesTaxRate();

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [jurisdictionDialog, setJurisdictionDialog] = useState<{ jurisdiction?: SalesTaxJurisdiction } | null>(null);
  const [rateDialog, setRateDialog] = useState<{ jurisdictionId: string; rate?: JurisdictionRate } | null>(null);
  const [toDelete, setToDelete] = useState<SalesTaxJurisdiction | null>(null);
  const [rateToDelete, setRateToDelete] = useState<{ jurisdictionId: string; rate: JurisdictionRate } | null>(null);

  const rows = useMemo(() => sortJurisdictions(query.data ?? []), [query.data]);
  // The dialog reads the live row, so a rate added a moment ago is already in `rates`.
  const rateJurisdiction = rateDialog ? rows.find((j) => j.id === rateDialog.jurisdictionId) : undefined;

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  let body: ReactNode;
  if (query.isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (query.isError) {
    body = <AgencyTabLoadError message={tj.loadError} retryLabel={t.common.retry} onRetry={() => void query.refetch()} />;
  } else if (rows.length === 0) {
    body = (
      <TabEmptyState
        illustration={<CompaniesIllustration />}
        title={tj.emptyTitle}
        description={tj.emptyDescription}
        action={access.canCreate ? { label: tj.add, onClick: () => setJurisdictionDialog({}) } : undefined}
      />
    );
  } else {
    body = (
      <TabListScope>
        <div className="border-t border-gray-200/70 dark:border-border">
          {rows.map((jurisdiction) => {
            const isOpen = expanded.has(jurisdiction.id);
            const Chevron = isOpen ? ChevronDown : ChevronRight;
            return (
              <div key={jurisdiction.id}>
                <TabListRow
                  label={jurisdiction.name}
                  onOpen={() => toggle(jurisdiction.id)}
                  menuLabel={tj.columns.actions}
                  menu={rowMenuItems({
                    canUpdate: access.canUpdate,
                    canDelete: access.canDelete,
                    editLabel: t.common.edit,
                    deleteLabel: t.common.delete,
                    onEdit: () => setJurisdictionDialog({ jurisdiction }),
                    onDelete: () => setToDelete(jurisdiction),
                    leading: access.canCreate ? (
                      <DropdownMenuItem onClick={() => setRateDialog({ jurisdictionId: jurisdiction.id })}>
                        <Plus />
                        {tj.addRate}
                      </DropdownMenuItem>
                    ) : undefined,
                  })}
                >
                  <Chevron className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{jurisdiction.name}</span>
                      {!jurisdiction.isActive ? <RowChip tone="gray">{tj.inactive}</RowChip> : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t.levels[jurisdiction.level] ?? jurisdiction.level}
                      {jurisdiction.code ? ` · ${jurisdiction.code}` : ''}
                    </div>
                  </div>
                  <span className="w-[96px] flex-shrink-0 text-right text-sm tabular-nums">
                    {jurisdiction.currentRate === null ? (
                      <span className="text-muted-foreground">{tj.noRateToday}</span>
                    ) : (
                      formatRatePercent(jurisdiction.currentRate)
                    )}
                  </span>
                </TabListRow>
                {isOpen ? (
                  <AgencyRateHistory
                    rates={jurisdiction.rates}
                    canUpdate={access.canUpdate}
                    canDelete={access.canDelete}
                    onEdit={(rate) => setRateDialog({ jurisdictionId: jurisdiction.id, rate })}
                    onDelete={(rate) => setRateToDelete({ jurisdictionId: jurisdiction.id, rate })}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </TabListScope>
    );
  }

  return (
    <section aria-label={tj.title}>
      <AgencyTabIntro
        intro={<p>{tj.intro}</p>}
        addLabel={access.canCreate && rows.length > 0 ? tj.add : undefined}
        onAdd={() => setJurisdictionDialog({})}
      />

      {body}

      <JurisdictionDialog
        agency={agency}
        jurisdiction={jurisdictionDialog?.jurisdiction}
        open={jurisdictionDialog !== null}
        onOpenChange={(open) => !open && setJurisdictionDialog(null)}
      />

      {rateJurisdiction ? (
        <RateDialog
          jurisdiction={rateJurisdiction}
          rate={rateDialog?.rate}
          open={rateDialog !== null}
          onOpenChange={(open) => !open && setRateDialog(null)}
        />
      ) : null}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={toDelete ? format(tj.deleteDialog.title, { name: toDelete.name }) : ''}
        description={tj.deleteDialog.description}
        confirmLabel={tj.deleteDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={removeJurisdiction.isPending}
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            await removeJurisdiction.mutateAsync(toDelete.id);
            toast.success(tj.deleted);
            setToDelete(null);
          } catch (err) {
            // A zone that still uses it comes back as a sentence naming the zone.
            toast.error(message(err, t.common.saveError));
            setToDelete(null);
          }
        }}
      />

      <ConfirmDialog
        open={rateToDelete !== null}
        onOpenChange={(open) => !open && setRateToDelete(null)}
        title={t.rates.deleteDialog.title}
        description={t.rates.deleteDialog.description}
        confirmLabel={t.rates.deleteDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={removeRate.isPending}
        onConfirm={async () => {
          if (!rateToDelete) return;
          try {
            await removeRate.mutateAsync({ jurisdictionId: rateToDelete.jurisdictionId, rateId: rateToDelete.rate.id });
            toast.success(t.rates.deleted);
          } catch (err) {
            toast.error(message(err, t.common.saveError));
          } finally {
            setRateToDelete(null);
          }
        }}
      />
    </section>
  );
}
