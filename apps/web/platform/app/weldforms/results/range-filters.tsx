import { X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';
import { useFormVersions } from '@/hooks/queries/use-weldforms-queries';

export interface RangeValue {
  from: string;
  to: string;
  versionId: string;
}

/** Version and date filters of the Summary and Insights tabs (`YYYY-MM-DD` dates). */
export function RangeFilters({
  formId,
  value,
  onChange,
  withVersion = true,
}: Readonly<{ formId: string; value: RangeValue; onChange: (value: RangeValue) => void; withVersion?: boolean }>) {
  const { t, format } = useI18n();
  const tr = t.weldformsResults.results;
  const versions = useFormVersions(formId);
  const dirty = value.from !== '' || value.to !== '' || value.versionId !== '';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {withVersion && (versions.data?.length ?? 0) > 1 && (
        <FilterSelect
          value={value.versionId || undefined}
          onChange={(versionId) => onChange({ ...value, versionId: versionId ?? '' })}
          options={(versions.data ?? []).map((v) => ({ value: v.id, label: format(tr.versionLabel, { number: v.number }) }))}
          allLabel={tr.allVersions}
          ariaLabel={tr.versionFilter}
        />
      )}
      <Input
        type="date"
        value={value.from}
        max={value.to || undefined}
        onChange={(e) => onChange({ ...value, from: e.target.value })}
        aria-label={tr.dateFrom}
        className="h-8 w-40"
      />
      <span className="text-sm text-muted-foreground">–</span>
      <Input
        type="date"
        value={value.to}
        min={value.from || undefined}
        onChange={(e) => onChange({ ...value, to: e.target.value })}
        aria-label={tr.dateTo}
        className="h-8 w-40"
      />
      {dirty && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ from: '', to: '', versionId: '' })}>
          <X className="mr-1 h-4 w-4" />
          {t.weldformsResults.common.clear}
        </Button>
      )}
    </div>
  );
}

function startIso(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function endIso(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The range as the summary / insights query (only the parts that are set). */
export function rangeQuery(value: RangeValue, withVersion = true): { from?: string; to?: string; versionId?: string } {
  const from = startIso(value.from);
  const to = endIso(value.to);
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(withVersion && value.versionId ? { versionId: value.versionId } : {}),
  };
}
