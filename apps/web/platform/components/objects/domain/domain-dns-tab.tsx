/**
 * DNS tab of the domain object panel — full record management.
 *
 * Cloudflare is the source of truth: every mutation goes through
 * `/api/dns-records/*`, which proxies to CF and re-syncs the local table
 * before responding. That means the list you see here is always the
 * reconciled server state, never an optimistic guess.
 *
 * Records other modules depend on (e.g. WeldMail's SPF/DKIM/MX entries)
 * carry a system lock in `metadata.locks`. Those rows render the lock badge
 * and their edit/delete buttons are disabled — the server enforces the same
 * rule with a 423, so this is an affordance, not the guard.
 *
 * Layout is a compact table (column header + dense rows) so many records
 * stay scannable at panel width. Type filter chips narrow the list without
 * burying content behind card chrome.
 */

import { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Lock, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  getDnsRecordLocks,
  useCreateDnsRecord,
  useDeleteDnsRecord,
  useUpdateDnsRecord,
  type DnsRecordInput,
  type HostDnsRecord,
} from '@/hooks/queries/use-host-queries';

/**
 * Types the panel offers for creation. PTR and SOA are accepted by the API
 * but are registry-managed — offering them here would only produce
 * Cloudflare errors.
 */
const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'] as const;

type PanelRecordType = (typeof DNS_RECORD_TYPES)[number];

/** Only these carry a meaningful priority in the Cloudflare API. */
const PRIORITY_TYPES = new Set<PanelRecordType>(['MX', 'SRV']);

const DEFAULT_TTL = 3600;

/** Compact row grid: type · name · content · ttl · actions */
const ROW_GRID =
  'grid grid-cols-[44px_minmax(0,1fr)_minmax(0,1.35fr)_44px_48px] items-center gap-x-2';

type DomainDetailTranslations = ReturnType<typeof useI18n>['t']['host']['domainDetail'];

/**
 * Form schema. TTL and priority stay strings because they're bound to
 * `<Input type="number">`, which yields `''` when cleared — coercing at the
 * schema level would turn that empty string into `0` and silently write an
 * invalid TTL. They're parsed in `toRecordInput` once validation has passed.
 *
 * Bounds mirror `createDnsRecordSchema` in
 * `@weldsuite/core-api-client/schemas/dns-records`, which revalidates
 * server-side. Messages come from the locale module, so the schema is built
 * per-render rather than hoisted to a module constant.
 */
function buildRecordSchema(td: DomainDetailTranslations) {
  const numeric = (raw: string, min: number, max: number) => {
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max;
  };

  return z
    .object({
      type: z.enum(DNS_RECORD_TYPES),
      name: z.string().trim().min(1, td.nameRequired).max(255),
      value: z.string().trim().min(1, td.valueRequired).max(2048),
      ttl: z.string(),
      priority: z.string(),
    })
    .superRefine((values, ctx) => {
      if (values.ttl.trim() && !numeric(values.ttl.trim(), 1, 86400)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ttl'], message: td.ttlRange });
      }
      // Priority is only sent for MX/SRV, so only validate it there — a stale
      // value left in the field after switching type away from MX must not
      // block the submit.
      if (
        PRIORITY_TYPES.has(values.type) &&
        values.priority.trim() &&
        !numeric(values.priority.trim(), 0, 65535)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['priority'],
          message: td.priorityRange,
        });
      }
    });
}

type RecordFormValues = z.infer<ReturnType<typeof buildRecordSchema>>;

/** Narrow validated form values into the API payload. */
function toRecordInput(values: RecordFormValues): DnsRecordInput {
  const data: DnsRecordInput = {
    type: values.type,
    name: values.name.trim(),
    value: values.value.trim(),
  };
  const ttl = values.ttl.trim();
  if (ttl) data.ttl = Number(ttl);
  const priority = values.priority.trim();
  if (priority && PRIORITY_TYPES.has(values.type)) data.priority = Number(priority);
  return data;
}

function emptyValues(): RecordFormValues {
  return { type: 'A', name: '', value: '', ttl: String(DEFAULT_TTL), priority: '' };
}

function valuesFromRecord(record: HostDnsRecord): RecordFormValues {
  return {
    type: record.type as PanelRecordType,
    name: record.name,
    value: record.value,
    ttl: String(record.ttl ?? DEFAULT_TTL),
    priority:
      record.priority === null || record.priority === undefined ? '' : String(record.priority),
  };
}

/** Short TTL label for the dense table (3600 → 1h). */
function formatTtl(ttl: number | null | undefined, autoLabel: string): string {
  if (ttl == null) return '—';
  if (ttl === 1) return autoLabel;
  if (ttl >= 86400 && ttl % 86400 === 0) return `${ttl / 86400}d`;
  if (ttl >= 3600 && ttl % 3600 === 0) return `${ttl / 3600}h`;
  if (ttl >= 60 && ttl % 60 === 0) return `${ttl / 60}m`;
  return `${ttl}s`;
}

// ─── Record form ───────────────────────────────────────────────────────────

/**
 * Add / edit form. Owns its own `useForm` instance — callers remount it (via
 * `key`) to switch records rather than resetting it from outside.
 *
 * `FormLabel` + `FormControl` derive a shared id from `FormItem`, so every
 * label is associated with its control without hand-rolled `useId` wiring.
 */
function RecordForm({
  title,
  defaultValues,
  onSubmit,
  onCancel,
  isPending,
  submitLabel,
  pendingLabel,
  td,
}: {
  title: string;
  defaultValues: RecordFormValues;
  onSubmit: (data: DnsRecordInput) => void | Promise<void>;
  onCancel: () => void;
  isPending: boolean;
  submitLabel: string;
  pendingLabel: string;
  td: DomainDetailTranslations;
}) {
  const schema = useMemo(() => buildRecordSchema(td), [td]);
  const form = useForm<RecordFormValues>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  const selectedType = form.watch('type');
  const showPriority = PRIORITY_TYPES.has(selectedType);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => onSubmit(toRecordInput(values)))}
        className="rounded-md border border-border bg-muted/20 p-3 space-y-3"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>

        <div className="grid grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="text-xs">{td.type}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {DNS_RECORD_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="ttl"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="text-xs">{td.ttlSeconds}</FormLabel>
                <FormControl>
                  <Input className="h-8" type="number" min={1} max={86400} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="space-y-1.5">
              <FormLabel className="text-xs">{td.recordName}</FormLabel>
              <FormControl>
                <Input
                  className="h-8 font-mono"
                  placeholder={td.recordNamePlaceholder}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="value"
          render={({ field }) => (
            <FormItem className="space-y-1.5">
              <FormLabel className="text-xs">{td.value}</FormLabel>
              <FormControl>
                <Input className="h-8 font-mono" placeholder={td.ipOrHostname} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {showPriority && (
          <FormField
            control={form.control}
            name="priority"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="text-xs">{td.priorityOptional}</FormLabel>
                <FormControl>
                  <Input
                    className="h-8"
                    type="number"
                    min={0}
                    max={65535}
                    placeholder="10"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPending}>
            {td.cancel}
          </Button>
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ─── Tab ───────────────────────────────────────────────────────────────────

interface DomainDnsTabProps {
  domainId: string;
  records: HostDnsRecord[];
  isLoading: boolean;
  /**
   * True when the domain has a Cloudflare-backed zone to write to. Separate
   * from the permission flags because the two produce different empty-state
   * copy: "no zone yet" vs "you can't edit this".
   */
  hasZone: boolean;
  /**
   * Per-action gates. Each is already ANDed with `hasZone` by the panel,
   * because the API proxies every mutation to CF and a pending zone has
   * nothing to write to. Kept separate rather than one `canManage` flag so a
   * user granted only `weldhost:dns:update` still gets the edit button
   * instead of a fully read-only tab.
   */
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Shown when the tab is entirely read-only — explains why. */
  readOnlyReason?: string;
  /** Help-doc preview — show the add-record form on first paint. */
  initialShowAddRecord?: boolean;
}

export function DomainDnsTab({
  domainId,
  records,
  isLoading,
  hasZone,
  canCreate,
  canEdit,
  canDelete,
  readOnlyReason,
  initialShowAddRecord,
}: DomainDnsTabProps) {
  const { t } = useI18n();
  const td = t.host.domainDetail;

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(initialShowAddRecord ?? false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<HostDnsRecord | null>(null);

  const createRecord = useCreateDnsRecord();
  const updateRecord = useUpdateDnsRecord();
  const deleteRecord = useDeleteDnsRecord();

  const isReadOnly = !canCreate && !canEdit && !canDelete;

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of records) {
      counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    }
    return counts;
  }, [records]);

  const typeChips = useMemo<string[]>(() => {
    const present: string[] = DNS_RECORD_TYPES.filter((type) => typeCounts.has(type));
    // Include any unexpected types returned by CF that aren't in the create list.
    for (const type of typeCounts.keys()) {
      if (!present.includes(type)) present.push(type);
    }
    return present;
  }, [typeCounts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (typeFilter && r.type !== typeFilter) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.value.toLowerCase().includes(q) ||
        r.type.toLowerCase().includes(q)
      );
    });
  }, [records, search, typeFilter]);

  const openAdd = useCallback(() => {
    setEditingId(null);
    setIsAdding(true);
  }, []);

  const openEdit = useCallback((record: HostDnsRecord) => {
    setIsAdding(false);
    setEditingId(record.id);
  }, []);

  const handleCreate = useCallback(
    async (data: DnsRecordInput) => {
      try {
        await createRecord.mutateAsync({ domainId, data });
        setIsAdding(false);
        toast.success(td.dnsRecordAdded);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : td.failedToAddRecord);
      }
    },
    [createRecord, domainId, td],
  );

  const handleUpdate = useCallback(
    async (recordId: string, data: DnsRecordInput) => {
      try {
        await updateRecord.mutateAsync({ id: recordId, domainId, data });
        setEditingId(null);
        toast.success(td.dnsRecordUpdated);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : td.failedToUpdateRecord);
      }
    },
    [updateRecord, domainId, td],
  );

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await deleteRecord.mutateAsync({ id: pendingDelete.id, domainId });
      toast.success(td.dnsRecordDeleted);
      setPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : td.failedToDeleteRecord);
    }
  }, [pendingDelete, deleteRecord, domainId, td]);

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={td.searchDnsRecords}
            className="h-8 pl-8"
          />
        </div>
        {canCreate && (
          <Button size="sm" className="h-8 flex-shrink-0" onClick={openAdd}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {td.addRecord}
          </Button>
        )}
      </div>

      {/* Type filter chips — only when there are records to narrow */}
      {records.length > 0 && typeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-pressed={typeFilter === null}
            onClick={() => setTypeFilter(null)}
            className={cn(
              'inline-flex h-6 items-center rounded px-2 text-[11px] font-medium transition-colors',
              typeFilter === null
                ? 'bg-foreground text-background'
                : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground',
            )}
          >
            {td.filterAllTypes}
            <span className="ml-1 tabular-nums opacity-70">{records.length}</span>
          </button>
          {typeChips.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={typeFilter === type}
              onClick={() => setTypeFilter((prev) => (prev === type ? null : type))}
              className={cn(
                'inline-flex h-6 items-center rounded px-2 font-mono text-[11px] font-medium transition-colors',
                typeFilter === type
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground',
              )}
            >
              {type}
              <span className="ml-1 tabular-nums opacity-70">{typeCounts.get(type)}</span>
            </button>
          ))}
        </div>
      )}

      {isReadOnly && readOnlyReason && (
        <p className="text-xs text-muted-foreground">{readOnlyReason}</p>
      )}

      {isAdding && canCreate && (
        <RecordForm
          title={td.newRecord}
          defaultValues={emptyValues()}
          onSubmit={handleCreate}
          onCancel={() => setIsAdding(false)}
          isPending={createRecord.isPending}
          submitLabel={td.addRecord}
          pendingLabel={td.adding}
          td={td}
        />
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-0 divide-y divide-border/60 rounded-md border border-border overflow-hidden">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-9 bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-foreground">
            {records.length === 0 ? td.noDnsRecordsTitle : td.noMatchingRecordsTitle}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {records.length === 0
              ? hasZone
                ? td.noDnsRecordsDescription
                : td.noDnsRecordsNoZone
              : td.noMatchingRecordsDescription}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          {/* Column headers */}
          <div
            className={cn(
              ROW_GRID,
              'border-b border-border bg-muted/40 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
            )}
          >
            <span>{td.type}</span>
            <span>{td.name}</span>
            <span>{td.value}</span>
            <span className="text-right">{td.ttl}</span>
            <span />
          </div>

          <div className="divide-y divide-border/60">
            {filtered.map((record) => {
              if (editingId === record.id) {
                return (
                  <div key={record.id} className="p-2.5 bg-muted/10">
                    <RecordForm
                      title={td.editRecord}
                      defaultValues={valuesFromRecord(record)}
                      onSubmit={(data) => handleUpdate(record.id, data)}
                      onCancel={() => setEditingId(null)}
                      isPending={updateRecord.isPending}
                      submitLabel={td.save}
                      pendingLabel={td.saving}
                      td={td}
                    />
                  </div>
                );
              }

              const locks = getDnsRecordLocks(record);
              const locked = locks.length > 0;
              // Locks are system-managed — users never lock/unlock from the UI,
              // they only see the protection and which module owns the record.
              const systemLock = locks.find((l) => l.source !== 'user');
              const lockLabel =
                systemLock?.source === 'weldmail'
                  ? td.usedByEmail
                  : systemLock
                    ? td.usedBy.replace('{source}', systemLock.source)
                    : td.filterLocked;
              const lockTooltip = locks.map((l) => l.reason).join('\n\n') || td.recordLocked;
              const hasPriority =
                record.priority !== null && record.priority !== undefined;
              const valueLabel = hasPriority
                ? `${record.priority} ${record.value}`
                : record.value;

              return (
                <div
                  key={record.id}
                  className={cn(
                    ROW_GRID,
                    'group min-h-[36px] px-2.5 py-1.5 hover:bg-muted/30 transition-colors',
                  )}
                >
                  <span className="font-mono text-[11px] font-semibold tabular-nums text-foreground">
                    {record.type}
                  </span>

                  <div className="min-w-0 flex items-center gap-1.5">
                    <span
                      className="truncate font-mono text-xs font-medium text-foreground"
                      title={record.name}
                    >
                      {record.name}
                    </span>
                    {locked && (
                      <span
                        className="inline-flex h-[18px] flex-shrink-0 items-center gap-0.5 rounded bg-blue-50 px-1 text-[10px] font-medium leading-none text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                        title={lockTooltip}
                      >
                        <Lock className="h-2.5 w-2.5" />
                        <span className="max-w-[72px] truncate">{lockLabel}</span>
                      </span>
                    )}
                  </div>

                  <span
                    className="min-w-0 truncate font-mono text-xs text-foreground/80"
                    title={
                      hasPriority
                        ? `${td.priority} ${record.priority} · ${record.value}`
                        : record.value
                    }
                  >
                    {valueLabel}
                  </span>

                  <span
                    className="text-right text-[11px] tabular-nums text-muted-foreground"
                    title={
                      record.ttl == null
                        ? '—'
                        : record.ttl === 1
                          ? td.ttlAuto
                          : `${record.ttl}s`
                    }
                  >
                    {formatTtl(record.ttl, td.ttlAuto)}
                  </span>

                  <div className="flex items-center justify-end gap-0.5">
                    {record.syncError && (
                      <span
                        role="img"
                        aria-label={record.syncError}
                        className="mr-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-500"
                        title={record.syncError}
                      />
                    )}
                    {(canEdit || canDelete) && (
                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={locked || updateRecord.isPending}
                            title={locked ? lockTooltip : td.edit}
                            aria-label={td.editRecordAriaLabel
                              .replace('{type}', record.type)
                              .replace('{name}', record.name)}
                            onClick={() => openEdit(record)}
                          >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={locked || deleteRecord.isPending}
                            title={locked ? lockTooltip : td.deleteAction}
                            aria-label={td.deleteRecordAriaLabel
                              .replace('{type}', record.type)
                              .replace('{name}', record.name)}
                            onClick={() => setPendingDelete(record)}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={td.deleteRecordTitle}
        description={
          pendingDelete
            ? td.deleteConfirm
                .replace('{type}', pendingDelete.type)
                .replace('{name}', pendingDelete.name)
            : ''
        }
        confirmLabel={td.deleteAction}
        cancelLabel={td.cancel}
        variant="destructive"
        loading={deleteRecord.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
