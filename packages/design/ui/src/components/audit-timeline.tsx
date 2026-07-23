import {
  ArrowRightLeft,
  UserPlus,
  AlertTriangle,
  Flag,
  Settings,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Archive,
} from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Skeleton } from '@weldsuite/ui/components/skeleton';

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

const actionIcons: Record<string, typeof ArrowRightLeft> = {
  created: Plus,
  deleted: Trash2,
  archived: Archive,
  status_changed: ArrowRightLeft,
  assigned: UserPlus,
  escalated: AlertTriangle,
  priority_changed: Flag,
};

const actionColors: Record<string, { icon: string; bg: string }> = {
  created: { icon: 'text-emerald-500', bg: 'bg-emerald-500/10' },
  deleted: { icon: 'text-red-500', bg: 'bg-red-500/10' },
  archived: { icon: 'text-gray-400', bg: 'bg-gray-500/10' },
  status_changed: { icon: 'text-blue-500', bg: 'bg-blue-500/10' },
  assigned: { icon: 'text-green-500', bg: 'bg-green-500/10' },
  escalated: { icon: 'text-amber-500', bg: 'bg-amber-500/10' },
  priority_changed: { icon: 'text-orange-500', bg: 'bg-orange-500/10' },
  updated: { icon: 'text-gray-400', bg: 'bg-gray-500/10' },
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ChangeDetails({ changes }: { changes: Record<string, { from: unknown; to: unknown }> }) {
  const entries = Object.entries(changes);
  if (entries.length === 0) return null;

  return (
    <div className="mt-1.5 space-y-0.5">
      {entries.map(([key, { from, to }]) => (
        <div key={key} className="text-[11px] text-muted-foreground">
          <span className="font-medium">{key}</span>:{' '}
          <span className="line-through opacity-60">{formatValue(from)}</span>
          {' → '}
          <span>{formatValue(to)}</span>
        </div>
      ))}
    </div>
  );
}

const HIDDEN_DATA_KEYS = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'workspaceId'];

function DataSnapshot({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(
    ([key, value]) =>
      !HIDDEN_DATA_KEYS.includes(key) && value !== null && value !== undefined && value !== '',
  );
  if (entries.length === 0) return null;

  return (
    <div className="mt-1.5 space-y-0.5">
      {entries.map(([key, value]) => (
        <div key={key} className="text-[11px] text-muted-foreground">
          <span className="font-medium">{key}</span>: <span>{formatValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

export function AuditTimelineSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-0">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3 py-2 pl-0 pr-2">
          <Skeleton className="h-5 w-5 shrink-0 rounded-[6px]" />
          <div className="flex-1 space-y-1.5 pt-0.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface AuditTimelineProps {
  logs: AuditLogEntry[];
  showEntityType?: boolean;
}

export function AuditTimeline({ logs, showEntityType }: AuditTimelineProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (logs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-sm text-muted-foreground">No activity yet</p>
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
        const Icon = actionIcons[log.action] || Settings;
        const colors = actionColors[log.action] || actionColors.updated;
        const hasChanges = log.changes && Object.keys(log.changes).length > 0;
        const hasData = log.data && Object.keys(log.data).length > 0;
        const hasDetails = hasChanges || hasData;
        const isExpanded = expandedIds.has(log.id);
        const isLast = index === logs.length - 1;

        return (
          <div key={log.id} className="flex">
            {/* Tree connector */}
            <div style={{ width: 20, flexShrink: 0, position: 'relative' }}>
              {/* Icon */}
              <div
                className={cn(
                  'relative z-10 flex items-center justify-center rounded-[6px]',
                  colors.bg,
                  colors.icon,
                )}
                style={{ width: 20, height: 20, marginTop: 2 }}
              >
                <Icon style={{ width: 10, height: 10 }} />
              </div>
              {/* Vertical line below icon */}
              {!isLast && (
                <div
                  style={{
                    position: 'absolute',
                    left: 9,
                    top: 24,
                    bottom: 0,
                    width: 1,
                    backgroundColor: 'var(--color-border)',
                  }}
                />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 pl-2.5 pb-4">
              <p className="text-[13px] leading-snug text-foreground pt-0.5">
                {showEntityType && log.entityType && (
                  <span className="mr-1.5 inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {log.entityType.replace(/_/g, ' ')}
                  </span>
                )}
                {log.description}
              </p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[11px] text-muted-foreground/70">
                  {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                </span>
              </div>

              {/* Expandable details */}
              {hasDetails && (
                <>
                  <button
                    onClick={() => toggleExpanded(log.id)}
                    className="flex items-center gap-0.5 mt-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                    Details
                  </button>
                  {isExpanded && hasChanges && <ChangeDetails changes={log.changes!} />}
                  {isExpanded && !hasChanges && hasData && <DataSnapshot data={log.data!} />}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
