import type { ReactNode } from 'react';
import { ChevronDown, Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useDimensionValues } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import type { ReportBasis, ReportCompare, ReportPeriods } from '@/lib/weldbooks/report-types';
import type { ReportParams } from './report-model';

/** Select items can't have an empty value, so "all" and "none" are sentinels. */
const ALL = '__all__';

export interface ReportToolbarDefaults {
  from?: string;
  to?: string;
  asOf?: string;
  basis?: ReportBasis | null;
}

export interface ReportExportControls {
  onCsv: () => void;
  onPdf: () => void;
  busy: 'csv' | 'pdf' | null;
  disabled?: boolean;
}

interface ReportToolbarProps {
  /** `period`: from and to; `asOf`: a single date; `none`: no date input. */
  dates: 'period' | 'asOf' | 'none';
  params: ReportParams;
  onChange: (patch: Partial<ReportParams>) => void;
  /** What the server answered for the inputs the user hasn't touched. */
  defaults?: ReportToolbarDefaults;
  showBasis?: boolean;
  showCompare?: boolean;
  /** Profit and loss: a column per month or quarter. */
  showPeriods?: boolean;
  /** Class and location filters; they only show when the entity has such values. */
  showDimensions?: boolean;
  exportControls?: ReportExportControls;
  isFetching?: boolean;
  /** Extra controls in front of the others (the account of the general ledger). */
  children?: ReactNode;
}

/**
 * The controls shared by every report page: dates, accrual or cash basis,
 * comparison, month or quarter columns, class and location filters and the
 * CSV and PDF export.
 */
export function ReportToolbar({
  dates,
  params,
  onChange,
  defaults = {},
  showBasis = true,
  showCompare = true,
  showPeriods = false,
  showDimensions = true,
  exportControls,
  isFetching = false,
  children,
}: Readonly<ReportToolbarProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const tb = t.accounting.reports;

  const classes = useDimensionValues({ dimension: 'class', isActive: true, limit: 500 }, { enabled: showDimensions });
  const locations = useDimensionValues({ dimension: 'location', isActive: true, limit: 500 }, { enabled: showDimensions });
  const classValues = classes.data ?? [];
  const locationValues = locations.data ?? [];

  const basis = params.basis || defaults.basis || 'accrual';
  const periodsLocked = params.compare !== '';
  const compareLocked = params.periods !== '';

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3" role="group" aria-label={tr.toolbar}>
      {children}

      {dates === 'period' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="report-from">{tb.from}</Label>
            <Input
              id="report-from"
              type="date"
              value={params.from || defaults.from || ''}
              onChange={(e) => onChange({ from: e.target.value })}
              className="w-40"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-to">{tb.to}</Label>
            <Input
              id="report-to"
              type="date"
              value={params.to || defaults.to || ''}
              onChange={(e) => onChange({ to: e.target.value })}
              className="w-40"
            />
          </div>
        </>
      ) : null}

      {dates === 'asOf' ? (
        <div className="space-y-1.5">
          <Label htmlFor="report-as-of">{tb.asOf}</Label>
          <Input
            id="report-as-of"
            type="date"
            value={params.asOf || defaults.asOf || ''}
            onChange={(e) => onChange({ asOf: e.target.value })}
            className="w-40"
          />
        </div>
      ) : null}

      {showBasis ? (
        <div className="space-y-1.5">
          <Label id="report-basis-label">{tr.basis}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={basis}
            aria-labelledby="report-basis-label"
            onValueChange={(value) => {
              if (value === 'accrual' || value === 'cash') onChange({ basis: value });
            }}
          >
            <ToggleGroupItem value="accrual" className="px-3">{tr.accrual}</ToggleGroupItem>
            <ToggleGroupItem value="cash" className="px-3">{tr.cash}</ToggleGroupItem>
          </ToggleGroup>
        </div>
      ) : null}

      {showCompare ? (
        <div className="space-y-1.5">
          <Label htmlFor="report-compare">{tr.compare}</Label>
          <Select
            value={params.compare || ALL}
            onValueChange={(value) => onChange({ compare: value === ALL ? '' : (value as ReportCompare) })}
            disabled={compareLocked}
          >
            <SelectTrigger id="report-compare" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tr.compareNone}</SelectItem>
              <SelectItem value="prior_period">{tr.comparePriorPeriod}</SelectItem>
              <SelectItem value="prior_year">{tr.comparePriorYear}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {showPeriods ? (
        <div className="space-y-1.5">
          <Label htmlFor="report-periods">{tr.columns}</Label>
          <Select
            value={params.periods || ALL}
            onValueChange={(value) => onChange({ periods: value === ALL ? '' : (value as ReportPeriods) })}
            disabled={periodsLocked}
          >
            <SelectTrigger id="report-periods" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tr.columnsTotal}</SelectItem>
              <SelectItem value="months">{tr.columnsMonths}</SelectItem>
              <SelectItem value="quarters">{tr.columnsQuarters}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {showDimensions && classValues.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="report-class">{tr.class}</Label>
          <Select value={params.classId || ALL} onValueChange={(value) => onChange({ classId: value === ALL ? '' : value })}>
            <SelectTrigger id="report-class" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              <SelectItem value={ALL}>{tr.allClasses}</SelectItem>
              {classValues.map((value) => (
                <SelectItem key={value.id} value={value.id}>
                  {value.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {showDimensions && locationValues.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="report-location">{tr.location}</Label>
          <Select
            value={params.locationId || ALL}
            onValueChange={(value) => onChange({ locationId: value === ALL ? '' : value })}
          >
            <SelectTrigger id="report-location" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              <SelectItem value={ALL}>{tr.allLocations}</SelectItem>
              {locationValues.map((value) => (
                <SelectItem key={value.id} value={value.id}>
                  {value.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        {isFetching ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {tr.updating}
          </span>
        ) : null}
        {exportControls ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={exportControls.disabled || exportControls.busy !== null}>
                {exportControls.busy ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Download className="mr-1 h-4 w-4" aria-hidden />
                )}
                {exportControls.busy ? tr.exporting : tr.export}
                <ChevronDown className="ml-1 h-3.5 w-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={exportControls.onCsv}>
                <FileSpreadsheet className="mr-2 h-4 w-4" aria-hidden />
                {tr.exportCsv}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={exportControls.onPdf}>
                <FileText className="mr-2 h-4 w-4" aria-hidden />
                {tr.exportPdf}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
