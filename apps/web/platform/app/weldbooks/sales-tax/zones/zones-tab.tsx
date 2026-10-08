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
import {
  useDeleteSalesTaxZone,
  useSalesTaxJurisdictions,
  useSalesTaxZones,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { SalesTaxAgency, SalesTaxZone } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useSetupTexts } from '../setup/setup-texts';
import type { SetupTabAccess } from '../rates/jurisdictions-tab';
import { formatCombinedRate } from './zone-model';
import { countZips, summarizeZipList } from './zip-list';
import { ZoneDialog } from './zone-dialog';

/** The tax zones of an agency: which jurisdictions apply together, for which ZIP codes. */
export function ZonesTab({ agency, access }: Readonly<{ agency: SalesTaxAgency; access: SetupTabAccess }>) {
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

  let body: React.ReactNode;
  if (zones.isLoading || jurisdictions.isLoading) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (zones.isError) {
    body = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{tz.loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void zones.refetch()}>
            {t.common.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (rows.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <p className="font-medium">{tz.emptyTitle}</p>
          <p className="mx-auto max-w-xl text-sm text-muted-foreground">
            {hasJurisdictions ? tz.emptyDescription : tz.needJurisdictions}
          </p>
          {access.canCreate && hasJurisdictions ? (
            <Button type="button" onClick={() => setDialog({})}>
              {tz.add}
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
              <TableHead>{tz.columns.name}</TableHead>
              <TableHead>{tz.columns.zips}</TableHead>
              <TableHead>{tz.columns.jurisdictions}</TableHead>
              <TableHead className="text-right">{tz.columns.combinedRate}</TableHead>
              <TableHead className="text-right">{tz.columns.priority}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((zone) => {
              const zips = summarizeZipList(zone.postalCodes);
              return (
                <TableRow key={zone.id}>
                  <TableCell className="font-medium">
                    {zone.name}
                    {zone.isOrigin ? (
                      <Badge variant="secondary" className="ml-2">
                        {tz.origin}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[260px]">
                    {zips.text ? (
                      <span title={plural(countZips(zone.postalCodes), tz.zipCount)}>
                        {zips.text}
                        {zips.more > 0 ? <span className="text-muted-foreground"> {format(tz.moreZips, { count: zips.more })}</span> : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{tz.noZips}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {zone.jurisdictions.map((j) => (
                        <Badge key={j.id} variant="outline">
                          {j.name}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatCombinedRate(zone.combinedRate)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{zone.priority}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {access.canUpdate ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`${t.common.edit}: ${zone.name}`}
                          onClick={() => setDialog({ zone })}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Button>
                      ) : null}
                      {access.canDelete ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`${t.common.delete}: ${zone.name}`}
                          onClick={() => setToDelete(zone)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="zones-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          <h2 id="zones-title" className="text-lg font-semibold">
            {tz.title}
          </h2>
          <p className="text-sm text-muted-foreground">{tz.intro}</p>
          <p className="text-sm text-muted-foreground">{tz.fallback}</p>
        </div>
        {access.canCreate && rows.length > 0 ? (
          <Button type="button" onClick={() => setDialog({})}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            {tz.add}
          </Button>
        ) : null}
      </div>

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
