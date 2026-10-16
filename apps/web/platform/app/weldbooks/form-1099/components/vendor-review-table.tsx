import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Users, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowChip,
  RowText,
  RowTitle,
  StatusChip,
  type ChipTone,
} from '@/components/accounting/weldbooks-row-cells';
import type { Form1099VendorRow, TinMatchStatus } from '@/lib/api/domains/weldbooks-1099';
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
  reportedAmount,
  vendorFixes,
  type ReviewFilter,
  type VendorFix,
} from '../form-1099-model';
import { BackupWithholdingButton } from './backup-withholding-button';

interface VendorReviewTableProps {
  vendors: readonly Form1099VendorRow[];
  onOpenDetails: (partyId: string) => void;
  /** The filter the list opens on. */
  initialFilter?: ReviewFilter;
}

/** A vendor of the review as the list takes it: the party id is the row's id. */
type VendorListRow = Form1099VendorRow & { id: string };

const VARIANT_TONE: Record<(typeof STATUS_VARIANT)[keyof typeof STATUS_VARIANT], ChipTone> = {
  success: 'green',
  warning: 'amber',
  secondary: 'gray',
  outline: 'gray',
  destructive: 'red',
};

const TIN_MATCH_TONE: Record<TinMatchStatus, ChipTone> = {
  match: 'green',
  pending: 'gray',
  mismatch: 'red',
  not_issued: 'red',
  invalid: 'red',
};

const REVIEW_FILTER_FIELD = 'view';

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
    <div className="flex flex-nowrap items-center justify-end gap-1.5">
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
 * vendor to fix it. A row opens the payments behind the vendor's boxes.
 */
export function VendorReviewTable({ vendors, onOpenDetails, initialFilter = 'to_file' }: Readonly<VendorReviewTableProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.form1099.review;
  const { formatMoney } = useWeldbooksFormat();
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([
    { id: 'review-view', field: REVIEW_FILTER_FIELD, operator: 'is', value: initialFilter },
  ]);
  const counts = useMemo(() => reviewFilterCounts(vendors), [vendors]);

  // The filter is applied here, not by the list, so its counts and the rows share one source.
  const rows = useMemo<VendorListRow[]>(() => {
    const view = activeFilters.find((filter) => filter.field === REVIEW_FILTER_FIELD && filter.operator && filter.value);
    return vendors
      .filter((row) => {
        if (!view) return true;
        const matches = matchesReviewFilter(row, view.value as ReviewFilter);
        return view.operator === 'is' ? matches : !matches;
      })
      .map((row) => ({ ...row, id: row.partyId }));
  }, [vendors, activeFilters]);

  const filters: FilterConfig[] = [
    {
      field: REVIEW_FILTER_FIELD,
      label: tr.filterLabel,
      options: REVIEW_FILTERS.map((value) => ({ value, label: `${tr.filters[value]} (${counts[value]})` })),
    },
  ];

  const columns: ColumnDef<VendorListRow>[] = [
    {
      id: 'vendor',
      header: tr.colVendor,
      width: 'min-w-[220px] flex-1 gap-2',
      render: (row) => (
        <>
          <Link
            to="/weldbooks/customers/$id"
            params={{ id: row.partyId }}
            title={row.legalName && row.legalName !== row.name ? row.legalName : undefined}
            className="flex min-w-0 hover:underline"
          >
            <RowTitle>{row.name || row.legalName}</RowTitle>
          </Link>
          {row.isAttorney ? <RowChip tone="gray">{tr.attorney}</RowChip> : null}
          {row.backupWithholding ? <RowChip tone="amber">{tr.backupWithholding}</RowChip> : null}
        </>
      ),
    },
    {
      id: 'status',
      header: tr.colStatus,
      width: 'w-[150px]',
      render: (row) => {
        const notes = [...row.reasons, row.unmappedAmount > 0 ? tr.unmapped.replace('{amount}', formatMoney(row.unmappedAmount)) : null].filter(
          (note): note is string => Boolean(note),
        );
        return (
          <span className="inline-flex min-w-0" title={notes.join('\n') || undefined}>
            <StatusChip tone={VARIANT_TONE[STATUS_VARIANT[row.status]]}>{t.weldbooksUs.form1099.vendorStatus[row.status]}</StatusChip>
          </span>
        );
      },
    },
    {
      id: 'boxes',
      header: tr.colBoxes,
      width: 'w-[120px]',
      render: (row) => {
        const entries = boxEntries(row.boxes);
        const reportable = entries.length > 0;
        const shown = reportable ? entries : boxEntries(row.totals);
        if (shown.length === 0) return <RowText />;
        const detail = shown.map((entry) => `${boxTag(entry.code)}: ${formatMoney(entry.amount)}`).join('\n');
        return (
          <span className="min-w-0" title={reportable ? detail : `${detail}\n${tr.notReported}`}>
            <RowAmount className={cn(!reportable && 'text-muted-foreground')}>
              {formatMoney(reportedAmount(reportable ? row.boxes : row.totals))}
            </RowAmount>
          </span>
        );
      },
    },
    {
      id: 'tin',
      header: tr.colTin,
      width: 'w-[170px] gap-2',
      render: (row) =>
        row.hasTin ? (
          <>
            <span className="font-mono text-xs text-gray-600 dark:text-muted-foreground">{row.tinMasked}</span>
            {row.tinMatchStatus ? (
              <RowChip tone={TIN_MATCH_TONE[row.tinMatchStatus]}>
                {t.weldbooksUs.form1099.tinMatch.status[row.tinMatchStatus]}
              </RowChip>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-amber-600 dark:text-amber-400">{tr.noTin}</span>
        ),
    },
    {
      id: 'address',
      header: tr.colAddress,
      width: 'w-[70px]',
      render: (row) => <Mark ok={row.addressComplete} label={row.addressComplete ? tr.addressComplete : tr.addressMissing} />,
    },
    {
      id: 'w9',
      header: tr.colW9,
      width: 'w-[60px]',
      render: (row) => <Mark ok={row.hasW9} label={row.hasW9 ? tr.w9Received : tr.w9Missing} />,
    },
    {
      id: 'actions',
      header: tr.colActions,
      width: 'w-[200px] justify-end',
      render: (row) => <FixActions row={row} />,
    },
  ];

  return (
    <div className="overflow-hidden rounded-md border" data-testid="vendor-review">
      <WeldbooksEntityList<VendorListRow>
        items={rows}
        isLoading={false}
        columns={columns}
        onRowClick={(row) => onOpenDetails(row.partyId)}
        getRowLabel={(row) => `${tr.details}: ${row.name || row.legalName}`}
        filters={filters}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        searchFields={['name', 'legalName']}
        searchPlaceholder={tr.searchPlaceholder}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Users className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: vendors.length === 0 ? tr.emptyYear : tr.emptyFilter,
          description: '',
        }}
        noResultsState={{ title: tr.emptyFilter, description: '' }}
      />
    </div>
  );
}
