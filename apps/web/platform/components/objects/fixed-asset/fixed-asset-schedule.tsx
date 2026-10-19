/**
 * The depreciation lists of a book inside the fixed asset panel.
 *
 * They are the panel's row lists (`TabListScope` + `TabListRow`) rather than
 * wide tables, so they fit the 480px panel: a row keeps its two or three
 * figures stacked and the posting status drops out on a narrow panel.
 */

import { Badge } from '@weldsuite/ui/components/badge';
import { useObjectPanel } from '@/components/object-panel';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { fill } from '@/app/weldbooks/fixed-assets/text';
import type { DepreciationRow, LedgerDepreciationRow } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** One figure of a row's detail line: label and amount kept together when the line wraps. */
function Figure({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <span className="whitespace-nowrap">
      {label} {value}
    </span>
  );
}

/** The yearly schedule of a book. The section 179 and bonus figures appear only when something was taken. */
export function AnnualScheduleList({ rows }: Readonly<{ rows: readonly DepreciationRow[] }>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.assets.fixedAssets.detail.annual;
  const { formatMoney } = useWeldbooksFormat();
  const showSection179 = rows.some((row) => row.section179 !== 0);
  const showBonus = rows.some((row) => row.bonus !== 0);

  return (
    <TabListScope>
      <div className="border-t border-gray-200/70 dark:border-border" data-testid="annual-schedule">
        {rows.map((row) => (
          <TabListRow key={`${row.label}-${row.periodStart}`} label={row.label}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{row.label}</div>
              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <Figure label={ta.accumulated} value={formatMoney(row.accumulated)} />
                {showSection179 || showBonus ? <Figure label={ta.regular} value={formatMoney(row.regular)} /> : null}
                {showSection179 ? <Figure label={ta.section179} value={formatMoney(row.section179)} /> : null}
                {showBonus ? <Figure label={ta.bonus} value={formatMoney(row.bonus)} /> : null}
              </div>
            </div>
            <div className="flex-shrink-0 text-right tabular-nums">
              <div className="text-sm font-medium">{formatMoney(row.amount)}</div>
              <div className="text-xs text-muted-foreground">
                {ta.remaining} {formatMoney(row.remaining)}
              </div>
            </div>
          </TabListRow>
        ))}
      </div>
    </TabListScope>
  );
}

/** The ledger book's stored periods (months, or 4-4-5 periods) and whether each is posted. */
export function LedgerPostingsList({ rows }: Readonly<{ rows: readonly LedgerDepreciationRow[] }>) {
  const { t } = useI18n();
  const tm = t.weldbooksUs.assets.fixedAssets.detail.monthly;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { open: openPanel } = useObjectPanel();
  const posted = rows.filter((row) => row.journalEntryId).length;

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{tm.empty}</p>;

  return (
    <div className="space-y-2" data-testid="ledger-postings">
      <div>
        <p className="text-sm font-medium">{tm.title}</p>
        <p className="text-xs text-muted-foreground">
          {tm.description} {fill(tm.postedCount, { posted, total: rows.length })}
        </p>
      </div>
      <TabListScope>
        <div className="max-h-96 overflow-auto border-t border-gray-200/70 dark:border-border">
          {rows.map((row) => {
            const period = `${formatDate(row.periodStart)} – ${formatDate(row.periodEnd)}`;
            const entryId = row.journalEntryId;
            return (
              <TabListRow
                key={row.id}
                label={period}
                onOpen={entryId ? () => openPanel({ type: 'journal_entry', id: entryId, stack: true }) : undefined}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm tabular-nums">{period}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {tm.accumulated} {formatMoney(row.accumulated)}
                  </div>
                </div>
                <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
                  {formatMoney(row.amount)}
                </span>
                <span className="w-[88px] flex-shrink-0 @max-[440px]:hidden">
                  <Badge variant={entryId ? 'success' : 'outline'}>{entryId ? tm.posted : tm.scheduled}</Badge>
                </span>
              </TabListRow>
            );
          })}
        </div>
      </TabListScope>
    </div>
  );
}
