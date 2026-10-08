import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Search, X } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import type { Form1099VendorRow } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  REVIEW_FILTERS,
  STATUS_VARIANT,
  boxEntries,
  boxTag,
  matchesReviewFilter,
  reviewFilterCounts,
  vendorFixes,
  type ReviewFilter,
  type VendorFix,
} from '../form-1099-model';
import { BackupWithholdingButton } from './backup-withholding-button';

interface VendorReviewTableProps {
  vendors: readonly Form1099VendorRow[];
  onOpenDetails: (partyId: string) => void;
  /** The filter the table opens on. */
  initialFilter?: ReviewFilter;
}

function Mark({ ok, label }: Readonly<{ ok: boolean; label: string }>) {
  return ok ? (
    <span className="inline-flex items-center text-emerald-600 dark:text-emerald-400" title={label}>
      <Check className="h-4 w-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  ) : (
    <span className="inline-flex items-center text-amber-600 dark:text-amber-400" title={label}>
      <X className="h-4 w-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function FixActions({ row }: Readonly<{ row: Form1099VendorRow }>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.form1099.review;
  const fixes = vendorFixes(row);
  const linkFixes = fixes.filter((fix): fix is Exclude<VendorFix, 'backup_withholding'> => fix !== 'backup_withholding');
  if (fixes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {linkFixes.map((fix) => (
        <Button key={fix} asChild variant="outline" size="xs">
          <Link to="/weldbooks/customers/$id/edit" params={{ id: row.partyId }}>
            {tr.fixes[fix]}
          </Link>
        </Button>
      ))}
      {fixes.includes('backup_withholding') ? <BackupWithholdingButton partyId={row.partyId} vendorName={row.name} size="xs" /> : null}
    </div>
  );
}

/**
 * The year-end review: every vendor with the status the computation gave it
 * and why, the boxes it would go on, and what is missing, with links to the
 * vendor to fix it.
 */
export function VendorReviewTable({ vendors, onOpenDetails, initialFilter = 'to_file' }: Readonly<VendorReviewTableProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.form1099.review;
  const { formatMoney } = useWeldbooksFormat();
  const [filter, setFilter] = useState<ReviewFilter>(initialFilter);
  const [search, setSearch] = useState('');
  const counts = useMemo(() => reviewFilterCounts(vendors), [vendors]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return vendors.filter(
      (row) =>
        matchesReviewFilter(row, filter) &&
        (!needle || row.name.toLowerCase().includes(needle) || row.legalName.toLowerCase().includes(needle)),
    );
  }, [vendors, filter, search]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr.filterLabel}>
          {REVIEW_FILTERS.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={filter === value ? 'default' : 'outline'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {tr.filters[value]}
              <span className="ml-1 tabular-nums opacity-70">{counts[value]}</span>
            </Button>
          ))}
        </div>
        <div className="relative w-full lg:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            className="pl-8"
            placeholder={tr.searchPlaceholder}
            aria-label={tr.searchPlaceholder}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-sm text-muted-foreground" data-testid="review-empty">
          {vendors.length === 0 ? tr.emptyYear : tr.emptyFilter}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr.colVendor}</TableHead>
                <TableHead>{tr.colStatus}</TableHead>
                <TableHead>{tr.colBoxes}</TableHead>
                <TableHead>{tr.colTin}</TableHead>
                <TableHead className="text-center">{tr.colAddress}</TableHead>
                <TableHead className="text-center">{tr.colW9}</TableHead>
                <TableHead className="text-right">{tr.colActions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const entries = boxEntries(row.boxes);
                const shown = entries.length > 0 ? entries : boxEntries(row.totals);
                const reportable = entries.length > 0;
                return (
                  <TableRow key={row.partyId} data-testid={`review-row-${row.partyId}`}>
                    <TableCell className="min-w-44">
                      <Link
                        to="/weldbooks/customers/$id"
                        params={{ id: row.partyId }}
                        className="font-medium hover:underline"
                      >
                        {row.name || row.legalName}
                      </Link>
                      {row.legalName && row.legalName !== row.name ? (
                        <p className="text-xs text-muted-foreground">{row.legalName}</p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.isAttorney ? <Badge variant="outline">{tr.attorney}</Badge> : null}
                        {row.backupWithholding ? <Badge variant="warning">{tr.backupWithholding}</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-52">
                      <Badge variant={STATUS_VARIANT[row.status]}>{t.weldbooksUs.form1099.vendorStatus[row.status]}</Badge>
                      {row.reasons.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          {row.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                      {row.unmappedAmount > 0 ? (
                        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                          {tr.unmapped.replace('{amount}', formatMoney(row.unmappedAmount))}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-40">
                      {shown.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <ul className={cn('space-y-0.5 text-sm', !reportable && 'text-muted-foreground')}>
                          {shown.map((entry) => (
                            <li key={entry.code} className="flex justify-between gap-3 tabular-nums">
                              <span className="text-xs text-muted-foreground">{boxTag(entry.code)}</span>
                              <span>{formatMoney(entry.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!reportable && shown.length > 0 ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">{tr.notReported}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-36">
                      {row.hasTin ? (
                        <div className="space-y-0.5">
                          <span className="font-mono text-xs">{row.tinMasked}</span>
                          {row.tinMatchStatus ? (
                            <div>
                              <Badge variant={row.tinMatchStatus === 'match' ? 'success' : row.tinMatchStatus === 'pending' ? 'secondary' : 'destructive'}>
                                {t.weldbooksUs.form1099.tinMatch.status[row.tinMatchStatus]}
                              </Badge>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-amber-600 dark:text-amber-400">{tr.noTin}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Mark ok={row.addressComplete} label={row.addressComplete ? tr.addressComplete : tr.addressMissing} />
                    </TableCell>
                    <TableCell className="text-center">
                      <Mark ok={row.hasW9} label={row.hasW9 ? tr.w9Received : tr.w9Missing} />
                    </TableCell>
                    <TableCell className="min-w-40 text-right">
                      <div className="flex flex-col items-end gap-1.5">
                        <Button type="button" variant="ghost" size="xs" onClick={() => onOpenDetails(row.partyId)}>
                          {tr.details}
                        </Button>
                        <FixActions row={row} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
