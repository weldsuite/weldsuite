/**
 * Breakdown: split a result by a column, an event property, a person property
 * or (with group types) a property of the event's group: the top N values,
 * the rest "Other", or numeric buckets (auto, or at edges you type).
 * `BreakdownsPicker` holds up to three breakdowns at once; their values are
 * joined in the result (`NL / mobile`).
 */

import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { Plus, X } from 'lucide-react';
import {
  PANEL_FILTER_COLUMNS,
  PANEL_MAX_BREAKDOWNS,
  panelBreakdownBucketSchema,
  panelBreakdownSchema,
  type PanelBreakdownBucket,
  type PanelFilterColumn,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { usePanelDefinitions } from './definitions';
import { PropertyPicker } from './pickers';

/** What a draft holds: a breakdown as a spec accepts it (the limit may still be left to the default). */
export type BreakdownValue = z.input<typeof panelBreakdownSchema>;

const NONE = '__none__';
const LIMITS = [5, 10, 15, 25] as const;
const BUCKET_COUNTS = [3, 4, 5, 6, 8, 10, 12, 15, 20] as const;
type BucketMode = 'values' | 'auto' | 'custom';

/** `10, 50, 100` → `[10, 50, 100]`; null when it is not a rising list of numbers. */
export function parseBucketEdges(text: string): number[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return null;
  const edges = parts.map(Number);
  const parsed = panelBreakdownBucketSchema.safeParse({ kind: 'custom', edges });
  return parsed.success && parsed.data.kind === 'custom' ? parsed.data.edges : null;
}

function BucketControl({ bucket, onChange, idPrefix }: Readonly<{ bucket: PanelBreakdownBucket | undefined; onChange: (bucket: PanelBreakdownBucket | undefined) => void; idPrefix: string }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.breakdown;
  const mode: BucketMode = bucket ? bucket.kind : 'values';
  const [edgesText, setEdgesText] = useState(bucket?.kind === 'custom' ? bucket.edges.join(', ') : '');
  // Follow edges set from outside (a saved report); text being typed that reads as the same edges stays as typed.
  useEffect(() => {
    if (bucket?.kind !== 'custom') return;
    setEdgesText((text) => (JSON.stringify(parseBucketEdges(text) ?? []) === JSON.stringify(bucket.edges) ? text : bucket.edges.join(', ')));
  }, [bucket]);
  const edgesInvalid = mode === 'custom' && edgesText.trim() !== '' && parseBucketEdges(edgesText) === null;

  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-bucket`}>{tx.bucket}</Label>
        <Select
          value={mode}
          onValueChange={(next) => {
            if (next === 'values') onChange(undefined);
            else if (next === 'auto') onChange({ kind: 'auto', count: 5 });
            else {
              const edges = parseBucketEdges(edgesText);
              onChange(edges ? { kind: 'custom', edges } : { kind: 'custom', edges: [] });
            }
          }}
        >
          <SelectTrigger id={`${idPrefix}-bucket`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="values">{tx.bucketModes.values}</SelectItem>
            <SelectItem value="auto">{tx.bucketModes.auto}</SelectItem>
            <SelectItem value="custom">{tx.bucketModes.custom}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {bucket?.kind === 'auto' && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-bucket-count`}>{tx.bucketCount}</Label>
          <Select value={String(bucket.count ?? 5)} onValueChange={(next) => onChange({ kind: 'auto', count: Number(next) })}>
            <SelectTrigger id={`${idPrefix}-bucket-count`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUCKET_COUNTS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {bucket?.kind === 'custom' && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-bucket-edges`}>{tx.bucketEdges}</Label>
          <Input
            id={`${idPrefix}-bucket-edges`}
            value={edgesText}
            placeholder="10, 50, 100"
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={edgesInvalid || undefined}
            onChange={(event) => {
              setEdgesText(event.target.value);
              onChange({ kind: 'custom', edges: parseBucketEdges(event.target.value) ?? [] });
            }}
          />
          <p className={edgesInvalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{edgesInvalid ? tx.bucketEdgesInvalid : tx.bucketEdgesHint}</p>
        </div>
      )}
    </>
  );
}

interface BreakdownPickerProps {
  projectId: string;
  value: BreakdownValue | undefined;
  onChange: (value: BreakdownValue | undefined) => void;
  idPrefix?: string;
  /** Show "No breakdown" as a choice (single breakdowns); a row of `BreakdownsPicker` is removed with its button instead. */
  allowNone?: boolean;
  /** Offer numeric buckets on property breakdowns. */
  allowBuckets?: boolean;
  /** The label of the source select. */
  label?: string;
  /** One field under the other, for a narrow column such as a report's settings sidebar. */
  stacked?: boolean;
}

export function BreakdownPicker({ projectId, value, onChange, idPrefix = 'weldpanel-breakdown', allowNone = true, allowBuckets = true, label, stacked = false }: Readonly<BreakdownPickerProps>) {
  const { t } = useI18n();
  const tb = t.weldpanel.analytics.breakdown;
  const tf = t.weldpanel.analytics.filters;
  const tx = t.weldpanel.explore.breakdown;
  const { groupTypes } = usePanelDefinitions();
  const limit = value?.limit ?? 10;

  function changeSource(next: string) {
    if (next === NONE) return onChange(undefined);
    if (next === 'column') return onChange({ source: 'column', field: 'country', limit });
    if (next === 'event') return onChange({ source: 'event', key: '', limit });
    if (next === 'group') return onChange({ source: 'group', groupType: groupTypes[0]?.groupType ?? '', key: '', limit });
    onChange({ source: 'person', key: '', limit });
  }

  const showGroup = groupTypes.length > 0 || value?.source === 'group';

  return (
    <div className={stacked ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'}>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-source`}>{label ?? tb.label}</Label>
        <Select value={value?.source ?? NONE} onValueChange={changeSource}>
          <SelectTrigger id={`${idPrefix}-source`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(allowNone || !value) && <SelectItem value={NONE}>{tb.none}</SelectItem>}
            <SelectItem value="column">{tb.sources.column}</SelectItem>
            <SelectItem value="event">{tb.sources.event}</SelectItem>
            <SelectItem value="person">{tb.sources.person}</SelectItem>
            {showGroup && <SelectItem value="group">{tx.groupSource}</SelectItem>}
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

      {value?.source === 'group' && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-group-type`}>{tx.groupType}</Label>
          <Select value={value.groupType} onValueChange={(groupType) => onChange({ ...value, groupType })}>
            <SelectTrigger id={`${idPrefix}-group-type`}>
              <SelectValue placeholder={tx.groupTypePlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {groupTypes.map((g) => (
                <SelectItem key={g.groupType} value={g.groupType}>
                  {g.nameSingular}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {(value?.source === 'event' || value?.source === 'person' || value?.source === 'group') && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-property`}>{tb.property}</Label>
          <PropertyPicker
            id={`${idPrefix}-property`}
            projectId={projectId}
            value={value.key}
            onChange={(key) => onChange({ ...value, key })}
            ariaLabel={tb.property}
            includeComputed={value.source === 'event'}
          />
        </div>
      )}

      {value && (value.source === 'column' || !value.bucket) && (
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

      {allowBuckets && value && value.source !== 'column' && (
        <BucketControl bucket={value.bucket} onChange={(bucket) => onChange({ ...value, bucket })} idPrefix={idPrefix} />
      )}
    </div>
  );
}

/** A breakdown a query can run: a column, or a property with a name (and a group type), with valid buckets. */
export function isBreakdownComplete(value: BreakdownValue | undefined): boolean {
  if (!value) return true;
  if (value.source === 'column') return true;
  if (value.key === '') return false;
  if (value.source === 'group' && value.groupType === '') return false;
  return value.bucket?.kind !== 'custom' || value.bucket.edges.length > 0;
}

/** The breakdowns of a list that can run (incomplete rows are left out until they are filled in). */
export function completeBreakdowns(values: readonly BreakdownValue[] | undefined): BreakdownValue[] | undefined {
  const complete = (values ?? []).filter((b) => isBreakdownComplete(b));
  return complete.length > 0 ? complete : undefined;
}

interface BreakdownsPickerProps {
  projectId: string;
  value: readonly BreakdownValue[];
  onChange: (value: BreakdownValue[]) => void;
  idPrefix?: string;
  max?: number;
  /** Each breakdown's fields one under the other, for a narrow column. */
  stacked?: boolean;
}

/** Up to {@link PANEL_MAX_BREAKDOWNS} breakdowns, each a row with a remove button. */
export function BreakdownsPicker({ projectId, value, onChange, idPrefix = 'weldpanel-breakdowns', max = PANEL_MAX_BREAKDOWNS, stacked = false }: Readonly<BreakdownsPickerProps>) {
  const { t } = useI18n();
  const tb = t.weldpanel.analytics.breakdown;
  const tx = t.weldpanel.explore.breakdown;

  return (
    <div className="grid gap-3" role="group" aria-label={tb.label}>
      {value.length === 0 && <p className="text-sm text-muted-foreground">{tb.none}</p>}
      {value.map((breakdown, index) => (
        <div key={index} className="flex items-start gap-2 rounded-lg border p-3">
          <div className="min-w-0 flex-1">
            <BreakdownPicker
              projectId={projectId}
              value={breakdown}
              allowNone={false}
              label={index === 0 ? tb.label : tx.thenBy}
              idPrefix={`${idPrefix}-${index}`}
              stacked={stacked}
              onChange={(next) => (next ? onChange(value.map((b, i) => (i === index ? next : b))) : onChange(value.filter((_, i) => i !== index)))}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mt-6 size-8 shrink-0"
            aria-label={tx.remove.replace('{n}', String(index + 1))}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      {value.length < max && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { source: 'column', field: 'country', limit: 10 }])}>
            <Plus />
            {value.length === 0 ? tx.add : tx.addAnother}
          </Button>
        </div>
      )}
    </div>
  );
}
