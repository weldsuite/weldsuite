import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useAuditLogs, type AuditLogFilters } from '@/hooks/queries/use-audit-log-queries';
import { useTeamMembers } from '@/hooks/queries/use-team-queries';
import { useCan } from '@weldsuite/permissions/react';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Button } from '@weldsuite/ui/components/button';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';
import { asText } from '@weldsuite/text';
import {
  ENTITY_TYPE_FILTER_GROUPS,
  actionLabel,
  createQuietTranslator,
  dayBounds,
  describeActivity,
  entityTypeLabel,
  recordHref,
  recordName,
} from './activity-format';

const ACTION_VALUES = [
  'created', 'updated', 'deleted', 'archived', 'unarchived',
  'won', 'lost', 'stage_changed', 'converted', 'completed', 'assigned', 'resolved', 'closed',
] as const;

const actionPillClass: Record<string, string> = {
  created: 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300',
  updated: 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300',
  deleted: 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300',
  archived: 'bg-gray-100 dark:bg-secondary text-gray-700 dark:text-muted-foreground',
  won: 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300',
  lost: 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300',
};

const COLUMN_COUNT = 6;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return asText(value);
}

function ChangeDetails({ changes, label }: Readonly<{ changes: Record<string, { from: unknown; to: unknown }>; label: string }>) {
  const entries = Object.entries(changes);
  if (entries.length === 0) return null;

  return (
    <div className="py-2 px-4 space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground mb-1 block">{label}</span>
      {entries.map(([key, { from, to }]) => (
        <div key={key} className="text-xs text-muted-foreground">
          <span className="text-[11px] font-medium text-muted-foreground">{key}</span>:{' '}
          <span className="line-through opacity-60">{formatValue(from)}</span>
          {' → '}
          <span>{formatValue(to)}</span>
        </div>
      ))}
    </div>
  );
}

const HIDDEN_DATA_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'workspaceId']);

function DataSnapshot({ data, label }: Readonly<{ data: Record<string, unknown>; label: string }>) {
  const entries = Object.entries(data).filter(
    ([key, value]) => !HIDDEN_DATA_KEYS.has(key) && value !== null && value !== undefined && value !== '',
  );
  if (entries.length === 0) return null;

  return (
    <div className="py-2 px-4 space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground mb-1 block">{label}</span>
      {entries.map(([key, value]) => (
        <div key={key} className="text-xs text-muted-foreground">
          <span className="text-[11px] font-medium text-muted-foreground">{key}</span>:{' '}
          <span>{formatValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

/** The select filters: the pill field, its query param, and the "is not" param. */
const SELECT_FILTER_PARAMS = {
  entityType: ['entityType', 'entityTypeNot'],
  action: ['action', 'actionNot'],
  performedBy: ['performedBy', 'performedByNot'],
} as const satisfies Record<string, readonly [keyof AuditLogFilters, keyof AuditLogFilters]>;

/** Apply a date pill ("is" / "before" / "after" a local day) to the query. */
function applyDateFilter(next: AuditLogFilters, operator: string | undefined, value: string): void {
  const bounds = dayBounds(value);
  if (!bounds) return;
  if (operator === 'before') next.endDate = bounds.start;
  else if (operator === 'after') next.startDate = bounds.end;
  else {
    next.startDate = bounds.start;
    next.endDate = bounds.end;
  }
}

/** Translate the active filter pills into list query params. */
function toQueryFilters(filters: ActiveFilter[], searchQuery: string, page: number): AuditLogFilters {
  const next: AuditLogFilters = { page, limit: 50 };
  if (searchQuery.trim()) next.search = searchQuery.trim();
  for (const f of filters) {
    if (!f.value) continue;
    if (f.field === 'date') {
      applyDateFilter(next, f.operator, f.value);
      continue;
    }
    const params = SELECT_FILTER_PARAMS[f.field as keyof typeof SELECT_FILTER_PARAMS];
    if (!params) continue;
    const [include, exclude] = params;
    next[f.operator === 'is not' ? exclude : include] = f.value;
  }
  return next;
}

export default function ActivitySettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.activity;
  const tr = useMemo(() => createQuietTranslator(t), [t]);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Members for the user filter (needs team:read; the filter is left out without it).
  const canReadTeam = useCan('team:read');
  const { data: membersResponse } = useTeamMembers(
    canReadTeam ? { limit: 100, status: 'ACTIVE', memberType: 'all' } : undefined,
  );

  const filterConfigs: FilterConfig[] = useMemo(() => {
    const configs: FilterConfig[] = [
      {
        field: 'entityType',
        label: ts.entityType,
        filterType: 'select',
        searchable: true,
        options: ENTITY_TYPE_FILTER_GROUPS.map((group) => ({
          value: group.join(','),
          label: entityTypeLabel(group[0], tr),
        })).sort((a, b) => a.label.localeCompare(b.label)),
      },
      {
        field: 'action',
        label: ts.action,
        filterType: 'select',
        options: ACTION_VALUES.map((v) => ({ value: v, label: actionLabel(v, tr) })),
      },
    ];
    const members = membersResponse?.data ?? [];
    if (members.length > 0) {
      configs.push({
        field: 'performedBy',
        label: ts.user,
        filterType: 'select',
        searchable: true,
        options: members
          .filter((m) => m.userId)
          .map((m) => ({ value: m.userId, label: m.name || ('email' in m ? m.email : null) || m.userId })),
      });
    }
    configs.push({ field: 'date', label: ts.date, filterType: 'date', options: [] });
    return configs;
  }, [ts, tr, membersResponse]);

  const queryFilters = useMemo(
    () => toQueryFilters(activeFilters, searchQuery, page),
    [activeFilters, searchQuery, page],
  );

  const { data, isLoading } = useAuditLogs(queryFilters);

  useEffect(() => {
    setPage(1);
  }, [activeFilters, searchQuery]);

  const logs = data?.data ?? [];
  const pagination = data?.pagination;

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>

      {/* Filters + table grouped tight */}
      <div className="space-y-3">
      {/* Filters */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />
        </div>

        <div className="flex items-center gap-2">
          <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={ts.searchPlaceholder} />
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[150px] text-[13.5px]">{ts.time}</TableHead>
              <TableHead className="w-[120px] text-[13.5px]">{ts.entityType}</TableHead>
              <TableHead className="w-[160px] text-[13.5px]">{ts.record}</TableHead>
              <TableHead className="w-[110px] text-[13.5px]">{ts.action}</TableHead>
              <TableHead className="text-[13.5px]">{ts.descriptionCol}</TableHead>
              <TableHead className="w-[44px] text-[13.5px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: COLUMN_COUNT }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            )}
            {!isLoading && logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="h-32 text-center text-muted-foreground">
                  {ts.noLogs}
                </TableCell>
              </TableRow>
            )}
            {!isLoading && logs.length > 0 && (
              logs.flatMap((log) => {
                const hasChanges = !!log.changes && Object.keys(log.changes).length > 0;
                const hasData =
                  !!log.data &&
                  Object.entries(log.data).some(
                    ([key, value]) =>
                      !HIDDEN_DATA_KEYS.has(key) &&
                      value !== null &&
                      value !== undefined &&
                      value !== '',
                  );
                const hasDetails = hasChanges || hasData;
                const isExpanded = expandedIds.has(log.id);
                const name = recordName(log);
                const href = name && log.action !== 'deleted' ? recordHref(log.entityType, log.entityId) : null;
                const rows = [
                  <TableRow
                    key={log.id}
                    className={cn(
                      'group h-[50px]',
                      hasDetails && 'cursor-pointer',
                      isExpanded && 'border-b-0 bg-muted/30 hover:bg-muted/30',
                    )}
                    onClick={hasDetails ? () => toggleExpanded(log.id) : undefined}
                  >
                    <TableCell className="text-sm tabular-nums">
                      {(() => {
                        const d = new Date(log.createdAt);
                        const fmt = d.getFullYear() === new Date().getFullYear()
                          ? 'h:mm a, MMM d'
                          : 'h:mm a, MMM d, yyyy';
                        return (
                          <span title={formatDistanceToNow(d, { addSuffix: true })}>
                            {format(d, fmt)}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center h-[22px] px-2 rounded text-xs leading-none font-normal border border-border bg-background text-foreground whitespace-nowrap">
                        {entityTypeLabel(log.entityType, tr)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm max-w-[160px] truncate">
                      {href ? (
                        <Link
                          href={href}
                          className="hover:underline underline-offset-2"
                          onClick={(e) => e.stopPropagation()}
                          title={name ?? undefined}
                        >
                          {name}
                        </Link>
                      ) : (
                        <span className={cn(!name && 'text-muted-foreground')} title={name ?? undefined}>
                          {name ?? '—'}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'inline-flex items-center h-[22px] px-2 rounded text-xs leading-none whitespace-nowrap',
                          actionPillClass[log.action] ?? 'bg-gray-100 dark:bg-secondary text-gray-700 dark:text-muted-foreground',
                        )}
                      >
                        {actionLabel(log.action, tr)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{describeActivity(log, tr)}</TableCell>
                    <TableCell>
                      {hasDetails && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(log.id);
                          }}
                        >
                          {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>,
                ];
                if (isExpanded && hasDetails) {
                  rows.push(
                    <TableRow key={`${log.id}-details`} className="hover:bg-transparent">
                      <TableCell colSpan={COLUMN_COUNT} className="p-0 bg-muted/30">
                        {hasChanges && <ChangeDetails changes={log.changes!} label={ts.changes} />}
                        {hasData && <DataSnapshot data={log.data!} label={ts.entityData} />}
                      </TableCell>
                    </TableRow>,
                  );
                }
                return rows;
              })
            )}
          </TableBody>
        </Table>
      </div>
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {ts.pagination.replace('{page}', String(pagination.page)).replace('{totalPages}', String(pagination.totalPages)).replace('{totalCount}', String(pagination.totalCount))}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-4 w-4 mr-1" /> {t.common.actions.previous}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!pagination.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              {t.common.actions.next} <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
