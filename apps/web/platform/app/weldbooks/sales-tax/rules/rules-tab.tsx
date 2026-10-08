import { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useDeleteSalesTaxRule, useSalesTaxRules } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { SalesTaxAgency, SalesTaxRule } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { formatRatePercent } from '../setup/format';
import { useSetupTexts } from '../setup/setup-texts';
import type { SetupTabAccess } from '../rates/jurisdictions-tab';
import { RuleDialog } from './rule-dialog';
import { isWeldTaxCode, sortRules } from './rule-model';

/** The taxability rules of an agency: how each product is taxed in the state, from when. */
export function RulesTab({ agency, access }: Readonly<{ agency: SalesTaxAgency; access: SetupTabAccess }>) {
  const { t } = useSetupTexts();
  const tr = t.rules;
  const { formatDate } = useWeldbooksFormat();
  const query = useSalesTaxRules(agency.id);
  const remove = useDeleteSalesTaxRule();
  const [dialog, setDialog] = useState<{ rule?: SalesTaxRule } | null>(null);
  const [toDelete, setToDelete] = useState<SalesTaxRule | null>(null);
  const rows = useMemo(() => sortRules(query.data ?? []), [query.data]);

  const codeLabel = (code: string) => (isWeldTaxCode(code) ? t.taxCodes[code].label : code);

  let body: React.ReactNode;
  if (query.isLoading) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (query.isError) {
    body = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{tr.loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t.common.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (rows.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <p className="font-medium">{tr.emptyTitle}</p>
          <p className="mx-auto max-w-xl text-sm text-muted-foreground">{tr.emptyDescription}</p>
          {access.canCreate ? (
            <Button type="button" onClick={() => setDialog({})}>
              {tr.add}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr.columns.taxCode}</TableHead>
              <TableHead>{tr.columns.taxable}</TableHead>
              <TableHead className="text-right">{tr.columns.percent}</TableHead>
              <TableHead>{tr.columns.use}</TableHead>
              <TableHead className="text-right">{tr.columns.rateOverride}</TableHead>
              <TableHead>{tr.columns.from}</TableHead>
              <TableHead>{tr.columns.to}</TableHead>
              <TableHead>{tr.columns.notes}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="font-medium">{codeLabel(rule.taxCode)}</TableCell>
                <TableCell>
                  <Badge variant={rule.taxable ? 'success' : 'outline'}>{rule.taxable ? tr.taxable : tr.notTaxable}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {rule.taxable ? formatRatePercent(rule.taxablePercent) : t.common.none}
                </TableCell>
                <TableCell>{t.uses[rule.appliesToUse] ?? rule.appliesToUse}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {rule.rateOverride === null ? tr.noOverride : formatRatePercent(rule.rateOverride)}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(rule.effectiveFrom)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {rule.effectiveTo ? formatDate(rule.effectiveTo) : tr.noEnd}
                </TableCell>
                <TableCell className="max-w-[260px] truncate text-muted-foreground" title={rule.notes ?? undefined}>
                  {rule.notes ?? t.common.none}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {access.canUpdate ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${t.common.edit}: ${codeLabel(rule.taxCode)}`}
                        onClick={() => setDialog({ rule })}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                    {access.canDelete ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${t.common.delete}: ${codeLabel(rule.taxCode)}`}
                        onClick={() => setToDelete(rule)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="rules-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          <h2 id="rules-title" className="text-lg font-semibold">
            {tr.title}
          </h2>
          <p className="text-sm text-muted-foreground">{tr.intro}</p>
        </div>
        {access.canCreate && rows.length > 0 ? (
          <Button type="button" onClick={() => setDialog({})}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            {tr.add}
          </Button>
        ) : null}
      </div>

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
