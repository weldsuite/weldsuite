'use client';

import { ChevronRight } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useUiLabels, type UiLabels } from '@weldsuite/ui/providers/ui-labels-provider';
import { asText } from '@weldsuite/text';

export interface AuditLogEntry {
  id: string;
  action: string;
  description: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  data?: Record<string, unknown>;
  performedBy?: string;
  performedByName?: string;
  createdAt: string;
  entityType?: string;
}

type AuditValueLabels = UiLabels['auditTimeline'];

function formatValue(value: unknown, labels: AuditValueLabels): string {
  if (value === null || value === undefined) return labels.none;
  if (typeof value === 'object') return JSON.stringify(value);
  return asText(value);
}

/** "dueDate" -> "Due date", "assigneeName" -> "Assignee". */
function formatFieldLabel(key: string): string {
  const words = key
    .replace(/(Name|Id)$/, '')
    .replaceAll('_', ' ')
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

const ENUM_LIKE_FIELDS = new Set(['status', 'priority', 'type']);
const ENUM_LABEL_OVERRIDES: Record<string, 'todo'> = { todo: 'todo' };

/** "in_progress" -> "In progress", "todo" -> "To Do" for status-like fields. */
function formatChangeValue(key: string, value: unknown, labels: AuditValueLabels): string {
  if (key === 'repeat' && value && typeof value === 'object') {
    const frequency = (value as { frequency?: unknown }).frequency;
    if (typeof frequency === 'string') return frequency;
  }
  if (typeof value === 'string' && ENUM_LIKE_FIELDS.has(key)) {
    const override = ENUM_LABEL_OVERRIDES[value];
    if (override) return labels[override];
    const words = value.replaceAll('_', ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(Date|At)$/.test(key)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
  }
  return formatValue(value, labels);
}

function ChangeDetails({ changes }: Readonly<{ changes: Record<string, { from: unknown; to: unknown }> }>) {
  const labels = useUiLabels().auditTimeline;
  const entries = Object.entries(changes);
  if (entries.length === 0) return null;

  return (
    <div>
      {entries.map(([key, { from, to }]) => (
        <p key={key} className="text-xs leading-[18px] text-muted-foreground">
          {formatFieldLabel(key)}: {formatChangeValue(key, from, labels)}
          <ChevronRight aria-hidden className="mx-1 inline size-3 align-[-2px]" />
          <span className="text-foreground/80">{formatChangeValue(key, to, labels)}</span>
        </p>
      ))}
    </div>
  );
}

const HIDDEN_DATA_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'workspaceId']);

function DataSnapshot({ data }: Readonly<{ data: Record<string, unknown> }>) {
  const labels = useUiLabels().auditTimeline;
  const entries = Object.entries(data).filter(
    ([key, value]) =>
      !HIDDEN_DATA_KEYS.has(key) && value !== null && value !== undefined && value !== '',
  );
  if (entries.length === 0) return null;

  return (
    <div>
      {entries.map(([key, value]) => (
        <p key={key} className="text-xs leading-[18px] text-muted-foreground">
          {formatFieldLabel(key)}: {formatValue(value, labels)}
        </p>
      ))}
    </div>
  );
}

/** Dot on the title line plus the hairline down to the next entry's dot. */
function TimelineRail({ isLast }: Readonly<{ isLast: boolean }>) {
  return (
    <div className="relative w-[5px] shrink-0">
      <span className="absolute left-0 top-[7.5px] size-[5px] rounded-full bg-muted-foreground/50" />
      {!isLast && <span className="absolute left-[2px] top-4 -bottom-1 w-px bg-border" />}
    </div>
  );
}

export function AuditTimelineSkeleton({ count = 3 }: Readonly<{ count?: number }>) {
  return (
    <div>
      {Array.from({ length: count }, (_, n) => `skeleton-row-${n}`).map((rowKey, index) => (
        <div key={rowKey} className="flex gap-3">
          <TimelineRail isLast={index === count - 1} />
          <div
            className={cn(
              'flex flex-1 items-center justify-between gap-4',
              index < count - 1 && 'pb-4',
            )}
          >
            <Skeleton className="my-[3px] h-3.5 w-1/2" />
            <Skeleton className="h-3 w-14" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface AuditTimelineProps {
  logs: AuditLogEntry[];
  /** Prefix each entry with its entity type (for timelines that mix record types). */
  showEntityType?: boolean;
}

/**
 * A record's activity history: one row per audit event with a dot on a
 * hairline rail, the description, a relative time and the field changes.
 * A full record snapshot (an event without changes) waits behind "Details".
 * Its text comes from the `auditTimeline` labels of `UiLabelsProvider`.
 */
export function AuditTimeline({ logs, showEntityType }: Readonly<AuditTimelineProps>) {
  const labels = useUiLabels().auditTimeline;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (logs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-sm text-muted-foreground">{labels.noActivity}</p>
      </div>
    );
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      {logs.map((log, index) => {
        const hasChanges = log.changes && Object.keys(log.changes).length > 0;
        const hasData = log.data && Object.keys(log.data).length > 0;
        const isExpanded = expandedIds.has(log.id);
        const isLast = index === logs.length - 1;

        return (
          <div key={log.id} className="flex gap-3">
            <TimelineRail isLast={isLast} />

            <div className={cn('min-w-0 flex-1', !isLast && 'pb-4')}>
              <div className="flex items-start justify-between gap-4">
                <p className="min-w-0 text-[13px] leading-5 text-foreground">
                  {showEntityType && log.entityType && (
                    <span className="text-muted-foreground">
                      {log.entityType.replaceAll('_', ' ')} ·{' '}
                    </span>
                  )}
                  {log.description}
                </p>
                <time
                  dateTime={log.createdAt}
                  className="relative top-px shrink-0 text-xs leading-5 tabular-nums text-muted-foreground"
                >
                  {formatDistanceToNowStrict(new Date(log.createdAt), { addSuffix: true })}
                </time>
              </div>

              {/* Field changes always show; a full record snapshot waits behind "Details". */}
              {hasChanges && <ChangeDetails changes={log.changes!} />}
              {!hasChanges && hasData && (
                <>
                  <button
                    type="button"
                    onClick={() => toggleExpanded(log.id)}
                    aria-expanded={isExpanded}
                    className="text-xs leading-[18px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {labels.details}
                  </button>
                  {isExpanded && <DataSnapshot data={log.data!} />}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
