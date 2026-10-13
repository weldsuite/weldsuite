/** The result of an import: what was created or updated, and why rows were left out. */

import { CheckCircle2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachImportReport } from '@weldsuite/app-api-client/schemas/reach';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import { ErrorBanner } from '@/app/weldreach/components/engage/kit';

type SkipReason = ReachImportReport['skipped'][number]['reason'];

const SKIP_REASON_KEYS: Record<SkipReason, string> = {
  valid: 'reachEngage.import.skipped.valid',
  role: 'reachEngage.import.skipped.role',
  consumer: 'reachEngage.import.skipped.consumer',
  no_mx: 'reachEngage.import.skipped.no_mx',
  invalid: 'reachEngage.import.skipped.invalid',
  suppressed: 'reachEngage.import.skipped.suppressed',
  duplicate: 'reachEngage.import.skipped.duplicate',
  invalid_row: 'reachEngage.import.skipped.invalid_row',
};

export function ImportReportView({
  report,
  error,
  onClose,
  onViewList,
}: Readonly<{
  report: ReachImportReport;
  /** Set when the import stopped part-way: the report then covers what was imported before. */
  error?: string | null;
  onClose: () => void;
  /** Filter the prospects table to the list the import filled. */
  onViewList?: (listId: string) => void;
}>) {
  const t = useTranslations();
  const format = useReachFormat();
  const skippedTotal = report.skipped.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="space-y-4">
      <ErrorBanner error={error ?? null} />

      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {t('reachEngage.import.report.summary', {
              created: format.number(report.created),
              updated: format.number(report.updated),
            })}
          </p>
          {skippedTotal > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('reachEngage.import.report.skippedTotal', { count: format.number(skippedTotal) })}
            </p>
          )}
        </div>
      </div>

      {report.skipped.length > 0 && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-sm font-medium">{t('reachEngage.import.report.skippedTitle')}</p>
          <ul className="space-y-1.5 text-sm">
            {report.skipped.map((entry) => (
              <li key={entry.reason} className="flex items-start justify-between gap-3">
                <span className="text-muted-foreground">{t(SKIP_REASON_KEYS[entry.reason])}</span>
                <span className="font-medium tabular-nums">{format.number(entry.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <DialogFooter>
        {report.listId && onViewList && (
          <Button type="button" variant="outline" onClick={() => onViewList(report.listId as string)}>
            {t('reachEngage.import.report.viewList')}
          </Button>
        )}
        <Button type="button" onClick={onClose}>
          {t('reachEngage.common.done')}
        </Button>
      </DialogFooter>
    </div>
  );
}
