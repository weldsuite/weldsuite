import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { RowChip } from '@/components/accounting/weldbooks-row-cells';
import { NotesIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { PageLoader } from '@/components/page-loader';
import { useDeleteSalesTaxRule, useSalesTaxRules } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { SalesTaxAgency, SalesTaxRule } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { formatRatePercent } from '@/app/weldbooks/sales-tax/setup/format';
import { useSetupTexts } from '@/app/weldbooks/sales-tax/setup/setup-texts';
import { RuleDialog } from '@/app/weldbooks/sales-tax/rules/rule-dialog';
import { isWeldTaxCode, sortRules } from '@/app/weldbooks/sales-tax/rules/rule-model';
import { AgencyTabIntro, AgencyTabLoadError, rowMenuItems } from './agency-tab-parts';
import type { AgencyTabAccess } from './sales-tax-agency-model';

/** The taxability rules of an agency: how each product is taxed in the state, from when. */
export function AgencyRulesTab({
  agency,
  access,
}: Readonly<{ agency: SalesTaxAgency; access: AgencyTabAccess }>) {
  const { t } = useSetupTexts();
  const tr = t.rules;
  const { formatDate } = useWeldbooksFormat();
  const query = useSalesTaxRules(agency.id);
  const remove = useDeleteSalesTaxRule();
  const [dialog, setDialog] = useState<{ rule?: SalesTaxRule } | null>(null);
  const [toDelete, setToDelete] = useState<SalesTaxRule | null>(null);
  const rows = useMemo(() => sortRules(query.data ?? []), [query.data]);

  const codeLabel = (code: string) => (isWeldTaxCode(code) ? t.taxCodes[code].label : code);

  let body: ReactNode;
  if (query.isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (query.isError) {
    body = <AgencyTabLoadError message={tr.loadError} retryLabel={t.common.retry} onRetry={() => void query.refetch()} />;
  } else if (rows.length === 0) {
    body = (
      <TabEmptyState
        illustration={<NotesIllustration />}
        title={tr.emptyTitle}
        description={tr.emptyDescription}
        action={access.canCreate ? { label: tr.add, onClick: () => setDialog({}) } : undefined}
      />
    );
  } else {
    body = (
      <TabListScope>
        <div className="border-t border-gray-200/70 dark:border-border">
          {rows.map((rule) => (
            <TabListRow
              key={rule.id}
              label={codeLabel(rule.taxCode)}
              onOpen={access.canUpdate ? () => setDialog({ rule }) : undefined}
              menuLabel={t.jurisdictions.columns.actions}
              menu={rowMenuItems({
                canUpdate: access.canUpdate,
                canDelete: access.canDelete,
                editLabel: t.common.edit,
                deleteLabel: t.common.delete,
                onEdit: () => setDialog({ rule }),
                onDelete: () => setToDelete(rule),
              })}
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{codeLabel(rule.taxCode)}</span>
                  <RowChip tone={rule.taxable ? 'green' : 'gray'}>{rule.taxable ? tr.taxable : tr.notTaxable}</RowChip>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {t.uses[rule.appliesToUse] ?? rule.appliesToUse} ·{' '}
                  <span className="tabular-nums text-foreground">{formatDate(rule.effectiveFrom)}</span> –{' '}
                  {rule.effectiveTo ? (
                    <span className="tabular-nums text-foreground">{formatDate(rule.effectiveTo)}</span>
                  ) : (
                    tr.noEnd
                  )}
                </div>
                {rule.rateOverride !== null ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {tr.columns.rateOverride}: {formatRatePercent(rule.rateOverride)}
                  </div>
                ) : null}
                {rule.notes ? (
                  <div className="truncate text-xs text-muted-foreground" title={rule.notes}>
                    {rule.notes}
                  </div>
                ) : null}
              </div>
              <span className="w-[72px] flex-shrink-0 text-right text-sm tabular-nums">
                {rule.taxable ? formatRatePercent(rule.taxablePercent) : t.common.none}
              </span>
            </TabListRow>
          ))}
        </div>
      </TabListScope>
    );
  }

  return (
    <section aria-label={tr.title}>
      <AgencyTabIntro
        intro={<p>{tr.intro}</p>}
        addLabel={access.canCreate && rows.length > 0 ? tr.add : undefined}
        onAdd={() => setDialog({})}
      />

      {body}

      <RuleDialog agency={agency} rule={dialog?.rule} open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)} />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={tr.deleteDialog.title}
        description={tr.deleteDialog.description}
        confirmLabel={tr.deleteDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            await remove.mutateAsync(toDelete.id);
            toast.success(tr.deleted);
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
