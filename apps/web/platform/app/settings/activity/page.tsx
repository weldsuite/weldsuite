import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useAuditLogs, type AuditLogFilters } from '@/hooks/queries/use-audit-log-queries';
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
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';

const ENTITY_TYPE_VALUES = [
  'all', 'contact', 'customer', 'product', 'order', 'invoice', 'bill',
  'helpdesk_conversation', 'helpdesk_ticket', 'project', 'personal_task',
  'parcel', 'shipment', 'lead', 'opportunity', 'journal_entry', 'payment', 'account',
] as const;

const ACTION_VALUES = ['all', 'created', 'updated', 'deleted', 'archived'] as const;

const actionPillClass: Record<string, string> = {
  created: 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300',
  updated: 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300',
  deleted: 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300',
  archived: 'bg-gray-100 dark:bg-secondary text-gray-700 dark:text-muted-foreground',
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ChangeDetails({ changes, label }: { changes: Record<string, { from: unknown; to: unknown }>; label: string }) {
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

const HIDDEN_DATA_KEYS = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'workspaceId'];

function DataSnapshot({ data, label }: { data: Record<string, unknown>; label: string }) {
  const entries = Object.entries(data).filter(
    ([key, value]) => !HIDDEN_DATA_KEYS.includes(key) && value !== null && value !== undefined && value !== '',
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

export default function ActivitySettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.activity;
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const filterConfigs: FilterConfig[] = useMemo(() => {
    const entityTypeLabels: Record<string, string> = {
      all: ts.allEntities,
      contact: ts.entityTypes.contact,
      customer: ts.entityTypes.customer,
      product: ts.entityTypes.product,
      order: ts.entityTypes.order,
      invoice: ts.entityTypes.invoice,
      bill: ts.entityTypes.bill,
      helpdesk_conversation: ts.entityTypes.conversation,
      helpdesk_ticket: ts.entityTypes.ticket,
      project: ts.entityTypes.project,
      personal_task: ts.entityTypes.task,
      parcel: ts.entityTypes.parcel,
      shipment: ts.entityTypes.shipment,
      lead: ts.entityTypes.lead,
      opportunity: ts.entityTypes.opportunity,
      journal_entry: ts.entityTypes.journalEntry,
      payment: ts.entityTypes.payment,
      account: ts.entityTypes.account,
    };

    const actionLabels: Record<string, string> = {
      all: ts.allActions,
      created: ts.actions.created,
      updated: ts.actions.updated,
      deleted: ts.actions.deleted,
      archived: ts.actions.archived,
    };

    return [
      {
        field: 'entityType',
        label: ts.entityType,
        filterType: 'select',
        searchable: true,
        options: ENTITY_TYPE_VALUES.filter((v) => v !== 'all').map((v) => ({
          value: v,
          label: entityTypeLabels[v] ?? v,
        })),
      },
      {
        field: 'action',
        label: ts.action,
        filterType: 'select',
        options: ACTION_VALUES.filter((v) => v !== 'all').map((v) => ({
          value: v,
          label: actionLabels[v] ?? v,
        })),
      },
      {
        field: 'startDate',
        label: ts.startDate,
        filterType: 'date',
        options: [],
      },
      {
        field: 'endDate',
        label: ts.endDate,
        filterType: 'date',
        options: [],
      },
    ];
  }, [ts]);

  const queryFilters: AuditLogFilters = useMemo(() => {
    const next: AuditLogFilters = { page, limit: 50 };
    if (searchQuery.trim()) next.entityId = searchQuery.trim();
    for (const f of activeFilters) {
      if (!f.value) continue;
      if (f.field === 'entityType') next.entityType = f.value;
      else if (f.field === 'action') next.action = f.value;
      else if (f.field === 'startDate') next.startDate = f.value;
      else if (f.field === 'endDate') next.endDate = f.value;
    }
    return next;
  }, [activeFilters, searchQuery, page]);

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
          <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={`${ts.entityId}...`} />
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px] text-[13.5px]">{ts.time}</TableHead>
              <TableHead className="w-[140px] text-[13.5px]">{ts.entityType}</TableHead>
              <TableHead className="w-[140px] text-[13.5px]">{ts.entityId}</TableHead>
              <TableHead className="w-[100px] text-[13.5px]">{ts.action}</TableHead>
              <TableHead className="text-[13.5px]">{ts.descriptionCol}</TableHead>
              <TableHead className="w-[60px] text-[13.5px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                  {ts.noLogs}
                </TableCell>
              </TableRow>
            ) : (
              logs.flatMap((log) => {
                const hasChanges = !!log.changes && Object.keys(log.changes).length > 0;
                const hasData =
                  !!log.data &&
                  Object.entries(log.data).some(
                    ([key, value]) =>
                      !HIDDEN_DATA_KEYS.includes(key) &&
                      value !== null &&
                      value !== undefined &&
                      value !== '',
                  );
                const hasDetails = hasChanges || hasData;
                const isExpanded = expandedIds.has(log.id);
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
                    <TableCell className="text-sm font-mono text-muted-foreground">
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
                      <span className="inline-flex items-center h-[22px] px-2 rounded text-xs leading-none font-normal border border-border bg-background text-foreground">
                        {log.entityType.replace(/_/g, ' ')}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm font-mono text-muted-foreground truncate max-w-[140px]">
                      {log.entityId}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'inline-flex items-center h-[22px] px-2 rounded text-xs leading-none',
                          actionPillClass[log.action] ?? 'bg-gray-100 dark:bg-secondary text-gray-700 dark:text-muted-foreground',
                        )}
                      >
                        {log.action}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{log.description}</TableCell>
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
                      <TableCell colSpan={6} className="p-0 bg-muted/30">
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
