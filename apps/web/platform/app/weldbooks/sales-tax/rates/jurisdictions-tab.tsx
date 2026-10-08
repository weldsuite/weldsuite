import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { formatRatePercent } from '../setup/format';
import { useSetupTexts } from '../setup/setup-texts';
import { JurisdictionDialog } from './jurisdiction-dialog';
import { RateDialog } from './rate-dialog';
import { RateHistory } from './rate-history';
import { sortJurisdictions } from './rate-model';

export interface SetupTabAccess {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The jurisdictions of an agency with their rate history, and the dialogs to change them. */
export function JurisdictionsTab({ agency, access }: Readonly<{ agency: SalesTaxAgency; access: SetupTabAccess }>) {
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
          <span>{tj.loadError}</span>
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
          <p className="font-medium">{tj.emptyTitle}</p>
          <p className="mx-auto max-w-xl text-sm text-muted-foreground">{tj.emptyDescription}</p>
          {access.canCreate ? (
            <Button type="button" onClick={() => setJurisdictionDialog({})}>
              {tj.add}
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
              <TableHead className="w-10" />
              <TableHead>{tj.columns.name}</TableHead>
              <TableHead>{tj.columns.level}</TableHead>
              <TableHead>{tj.columns.code}</TableHead>
              <TableHead className="text-right">{tj.columns.currentRate}</TableHead>
              <TableHead className="text-right">{tj.columns.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((jurisdiction) => {
              const isOpen = expanded.has(jurisdiction.id);
              return (
                <Fragment key={jurisdiction.id}>
                  <TableRow>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? tj.hideHistory : tj.showHistory}
                        onClick={() => toggle(jurisdiction.id)}
                      >
                        {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                      </Button>
                    </TableCell>
                    <TableCell className="font-medium">
                      {jurisdiction.name}
                      {!jurisdiction.isActive ? (
                        <Badge variant="outline" className="ml-2">
                          {tj.inactive}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>{t.levels[jurisdiction.level] ?? jurisdiction.level}</TableCell>
                    <TableCell className="text-muted-foreground">{jurisdiction.code ?? t.common.none}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {jurisdiction.currentRate === null ? (
                        <span className="text-muted-foreground">{tj.noRateToday}</span>
                      ) : (
                        formatRatePercent(jurisdiction.currentRate)
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-1">
                        {access.canCreate ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setRateDialog({ jurisdictionId: jurisdiction.id })}
                          >
                            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
                            {tj.addRate}
                          </Button>
                        ) : null}
                        {access.canUpdate ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`${t.common.edit}: ${jurisdiction.name}`}
                            onClick={() => setJurisdictionDialog({ jurisdiction })}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </Button>
                        ) : null}
                        {access.canDelete ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`${t.common.delete}: ${jurisdiction.name}`}
                            onClick={() => setToDelete(jurisdiction)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                  {isOpen ? (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={5} className="p-0">
                        <RateHistory
                          rates={jurisdiction.rates}
                          canUpdate={access.canUpdate}
                          canDelete={access.canDelete}
                          onEdit={(rate) => setRateDialog({ jurisdictionId: jurisdiction.id, rate })}
                          onDelete={(rate) => setRateToDelete({ jurisdictionId: jurisdiction.id, rate })}
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="jurisdictions-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          <h2 id="jurisdictions-title" className="text-lg font-semibold">
            {tj.title}
          </h2>
          <p className="text-sm text-muted-foreground">{tj.intro}</p>
        </div>
        {access.canCreate && rows.length > 0 ? (
          <Button type="button" onClick={() => setJurisdictionDialog({})}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            {tj.add}
          </Button>
        ) : null}
      </div>

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
