/** Breakdown: split a result by a column, an event property or a person property (top N values, the rest is "Other"). */

import type { z } from 'zod';
import { PANEL_FILTER_COLUMNS, panelBreakdownSchema, type PanelFilterColumn } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { PropertyPicker } from './pickers';

/** What a draft holds: a breakdown as a spec accepts it (the limit may still be left to the default). */
export type BreakdownValue = z.input<typeof panelBreakdownSchema>;

const NONE = '__none__';
const LIMITS = [5, 10, 15, 25] as const;

interface BreakdownPickerProps {
  projectId: string;
  value: BreakdownValue | undefined;
  onChange: (value: BreakdownValue | undefined) => void;
  idPrefix?: string;
}

export function BreakdownPicker({ projectId, value, onChange, idPrefix = 'weldpanel-breakdown' }: Readonly<BreakdownPickerProps>) {
  const { t } = useI18n();
  const tb = t.weldpanel.analytics.breakdown;
  const tf = t.weldpanel.analytics.filters;
  const limit = value?.limit ?? 10;

  function changeSource(next: string) {
    if (next === NONE) return onChange(undefined);
    if (next === 'column') return onChange({ source: 'column', field: 'country', limit });
    if (next === 'event') return onChange({ source: 'event', key: '', limit });
    onChange({ source: 'person', key: '', limit });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-source`}>{tb.label}</Label>
        <Select value={value?.source ?? NONE} onValueChange={changeSource}>
          <SelectTrigger id={`${idPrefix}-source`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{tb.none}</SelectItem>
            <SelectItem value="column">{tb.sources.column}</SelectItem>
            <SelectItem value="event">{tb.sources.event}</SelectItem>
            <SelectItem value="person">{tb.sources.person}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {value?.source === 'column' && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-field`}>{tb.field}</Label>
          <Select value={value.field} onValueChange={(field) => onChange({ ...value, field: field as PanelFilterColumn })}>
            <SelectTrigger id={`${idPrefix}-field`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PANEL_FILTER_COLUMNS.map((column) => (
                <SelectItem key={column} value={column}>
                  {tf.columns[column]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {(value?.source === 'event' || value?.source === 'person') && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-property`}>{tb.property}</Label>
          <PropertyPicker id={`${idPrefix}-property`} projectId={projectId} value={value.key} onChange={(key) => onChange({ ...value, key })} ariaLabel={tb.property} />
        </div>
      )}

      {value && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-limit`}>{tb.limit}</Label>
          <Select value={String(limit)} onValueChange={(next) => onChange({ ...value, limit: Number(next) })}>
            <SelectTrigger id={`${idPrefix}-limit`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMITS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {tb.limitValue.replace('{count}', String(n))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

/** A breakdown a query can run: a column, or a property with a name. */
export function isBreakdownComplete(value: BreakdownValue | undefined): boolean {
  if (!value) return true;
  return value.source === 'column' || value.key !== '';
}
