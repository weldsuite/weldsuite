import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useApplyTaxLines, useTaxLineCatalog } from '@/hooks/queries/use-accounting-queries';
import type { ApplyTaxLinesResult } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { taxLineLabel } from '@/lib/weldbooks/tax-lines';

interface RemapTaxLinesDialogProps {
  /**
   * `classification`: offered after a save that changed the return the entity
   * files. `defaults`: the user asked to apply the default mapping.
   */
  mode?: 'classification' | 'defaults';
  entityId: string;
  /** The return the entity files now, e.g. `Form 1120-S`. */
  formLabel?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Offered after a save that changed the return the entity files. Remaps every
 * account to the lines of the new return, then lists what changed.
 */
export function RemapTaxLinesDialog({
  mode = 'classification',
  entityId,
  formLabel,
  open,
  onOpenChange,
}: Readonly<RemapTaxLinesDialogProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.setup.remap;
  const canUpdateAccounts = useCan('accounts:update');
  const applyTaxLines = useApplyTaxLines();
  const [overwrite, setOverwrite] = useState(false);
  const [result, setResult] = useState<ApplyTaxLinesResult | null>(null);

  useEffect(() => {
    if (open) {
      setOverwrite(false);
      setResult(null);
    }
  }, [open]);

  // The catalog of the new return names the lines the accounts landed on.
  const catalogQuery = useTaxLineCatalog(result?.taxYear, { enabled: open && result !== null });

  const remap = async () => {
    try {
      const res = await applyTaxLines.mutateAsync({ entityId, data: { overwrite } });
      setResult(res.data);
    } catch (err) {
      toast.error(tr.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Dialog open={open} onOpenChange={applyTaxLines.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>{tr.resultTitle}</DialogTitle>
              <DialogDescription>
                {tr.resultSummary
                  .replace('{updated}', String(result.updated))
                  .replace('{unchanged}', String(result.unchanged))
                  .replace('{kept}', String(result.keptOverrides))}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <section aria-labelledby="remap-changes">
                <h3 id="remap-changes" className="mb-2 text-sm font-medium">{tr.changes}</h3>
                {result.changes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{tr.noChanges}</p>
                ) : (
                  <div className="max-h-64 overflow-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-muted/60 text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">{tr.colAccount}</th>
                          <th className="px-3 py-2 font-medium">{tr.colFrom}</th>
                          <th className="px-3 py-2 font-medium">{tr.colTo}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.changes.map((change) => (
                          <tr key={change.accountId} className="border-t">
                            <td className="px-3 py-2">
                              <span className="font-mono text-xs text-muted-foreground">{change.code}</span> {change.name}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {change.from ? change.from : tr.none}
                            </td>
                            <td className="px-3 py-2">
                              {change.to ? taxLineLabel(catalogQuery.data, change.to) : tr.none}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {result.unmapped.length > 0 ? (
                <section aria-labelledby="remap-unmapped" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <h3 id="remap-unmapped" className="text-sm font-medium">
                    {tr.unmapped.replace('{count}', String(result.unmapped.length))}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">{tr.unmappedHelp}</p>
                  <ul className="mt-2 max-h-28 space-y-0.5 overflow-auto text-sm">
                    {result.unmapped.map((account) => (
                      <li key={account.accountId}>
                        <span className="font-mono text-xs text-muted-foreground">{account.code}</span> {account.name}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" asChild>
                <Link to="/weldbooks/accounts/tax-lines" onClick={() => onOpenChange(false)}>
                  {tr.openMapping}
                </Link>
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {tr.done}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{mode === 'defaults' ? tr.defaultsTitle : tr.title}</DialogTitle>
              <DialogDescription>
                {mode === 'defaults'
                  ? tr.defaultsDescription.replace('{form}', formLabel ?? '')
                  : formLabel
                    ? tr.description.replace('{form}', formLabel)
                    : tr.descriptionNoForm}
              </DialogDescription>
            </DialogHeader>

            {canUpdateAccounts ? (
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={overwrite}
                  onCheckedChange={(checked) => setOverwrite(checked === true)}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  {tr.overwrite}
                  <span className="block text-xs text-muted-foreground">{tr.overwriteHelp}</span>
                </span>
              </label>
            ) : (
              <p className="text-sm text-muted-foreground">{tr.noPermission}</p>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" disabled={applyTaxLines.isPending} onClick={() => onOpenChange(false)}>
                {tr.later}
              </Button>
              <Button type="button" disabled={!canUpdateAccounts || applyTaxLines.isPending} onClick={() => void remap()}>
                {applyTaxLines.isPending ? tr.remapping : tr.remap}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
