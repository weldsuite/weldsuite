/**
 * Responses table: columns from the API (merged across versions) with a column
 * picker, filters, search, cursor pagination, a drawer per response, bulk
 * delete and CSV / XLSX export. Partial responses are labelled, and one that
 * has gone quiet for a day is marked abandoned.
 */

import { useEffect, useMemo, useState } from 'react';
import { Columns3, Download, Inbox, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  FORM_LIMITS,
  type FormDetail,
  type FormResponseColumn,
  type FormResponseDto,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useFormVersions } from '@/hooks/queries/use-weldforms-queries';
import {
  saveBlob,
  useBulkDeleteFormResponses,
  useExportFormResponses,
  useFormColumns,
  useFormResponses,
  useVersionDefinitions,
} from '@/hooks/queries/use-weldforms-results-queries';
import { errorMessage } from './form-gate';
import { FiltersPanel } from './filters-panel';
import { EMPTY_FILTERS, activeFilterCount, toResponsesQuery, type ResponsesFilterState } from './filters';
import { formatDuration } from './insights-tab';
import { cellText, defaultVisibleKeys, fieldIndex, metaCell } from './response-cells';
import { ResponseDrawer } from './response-drawer';

const SORTS = ['newest', 'oldest', 'score_desc', 'score_asc'] as const;

function storageKey(formId: string): string {
  return `weldforms:response-columns:${formId}`;
}

function readStoredColumns(formId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(storageKey(formId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((k) => typeof k === 'string') ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function writeStoredColumns(formId: string, keys: string[] | null): void {
  try {
    if (keys === null) window.localStorage.removeItem(storageKey(formId));
    else window.localStorage.setItem(storageKey(formId), JSON.stringify(keys));
  } catch {
    // Private mode or blocked storage: the picker still works for this visit.
  }
}

export function ResponsesTab({ form }: Readonly<{ form: FormDetail }>) {
  const { t, format, language } = useI18n();
  const tr = t.weldformsResults.results;
  const trr = tr.responses;

  const [filters, setFilters] = useState<ResponsesFilterState>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [stored, setStored] = useState<string[] | null>(() => readStoredColumns(form.id));

  // The search box applies half a second after the last key.
  useEffect(() => {
    const timer = setTimeout(() => setFilters((current) => (current.q === search.trim() ? current : { ...current, q: search.trim() })), 400);
    return () => clearTimeout(timer);
  }, [search]);

  const query = toResponsesQuery(filters);
  const columnsQuery = useFormColumns(form.id);
  const versions = useFormVersions(form.id);
  const list = useFormResponses(form.id, query);
  const bulkDelete = useBulkDeleteFormResponses(form.id);
  const exporter = useExportFormResponses(form.id);

  const columns = useMemo(() => columnsQuery.data ?? [], [columnsQuery.data]);
  const visibleKeys = useMemo(() => stored ?? defaultVisibleKeys(columns), [stored, columns]);
  const visibleColumns = columns.filter((c) => visibleKeys.includes(c.key));

  const { responses } = list;
  const versionIds = useMemo(() => [...new Set(responses.map((r) => r.versionId))], [responses]);
  const definitions = useVersionDefinitions(form.id, versionIds);
  const fieldsByVersion = useMemo(() => {
    const map = new Map<string, ReturnType<typeof fieldIndex>>();
    for (const [versionId, definition] of definitions) map.set(versionId, fieldIndex(definition));
    return map;
  }, [definitions]);

  const filterCount = activeFilterCount(filters) + (filters.q ? 1 : 0);
  const allSelected = responses.length > 0 && responses.every((r) => selected.includes(r.id));
  const canDelete = form.permissions.deleteResponses;
  const canExport = form.permissions.exportResponses;
  const dash = t.weldformsResults.common.noValue;
  const dateTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });

  function setVisible(keys: string[] | null) {
    setStored(keys);
    writeStoredColumns(form.id, keys);
  }

  function toggleColumn(column: FormResponseColumn, on: boolean) {
    const current = new Set(visibleKeys);
    if (on) current.add(column.key);
    else current.delete(column.key);
    setVisible(columns.filter((c) => current.has(c.key)).map((c) => c.key));
  }

  async function runExport(kind: 'csv' | 'xlsx') {
    const toastId = toast.loading(trr.exporting);
    try {
      const { sort: _sort, ...rest } = query;
      const file = await exporter.mutateAsync({ ...rest, format: kind });
      saveBlob(file.blob, file.filename);
      toast.success(trr.export, { id: toastId });
    } catch (err) {
      toast.error(errorMessage(err, trr.exportFailed), { id: toastId });
    }
  }

  async function runBulkDelete() {
    try {
      await bulkDelete.mutateAsync(selected);
      toast.success(trr.bulkDeleteDone);
      setSelected([]);
    } catch (err) {
      toast.error(errorMessage(err, t.weldformsResults.results.drawer.deleteFailed));
    } finally {
      setConfirmBulk(false);
    }
  }

  function renderCell(column: FormResponseColumn, response: FormResponseDto): string {
    if (!column.blockId) {
      const meta = metaCell(response, column.key);
      if (!meta) return dash;
      switch (meta.type) {
        case 'number':
          return `#${meta.value}`;
        case 'date':
          return dateTime.format(new Date(meta.value));
        case 'duration':
          return formatDuration(meta.value, tr.insights.durationFormat, format) ?? dash;
        case 'status':
          return meta.value === 'completed' ? trr.completed : meta.value === 'abandoned' ? trr.abandoned : trr.inProgress;
        default:
          return String(meta.value);
      }
    }
    const text = cellText(column, response, fieldsByVersion.get(response.versionId));
    return text && text.length > 0 ? text : dash;
  }

  if (columnsQuery.isLoading || (list.isLoading && responses.length === 0)) {
    return <PageLoader fullScreen={false} className="min-h-60" />;
  }
  if (columnsQuery.error || list.error) {
    return <ErrorState message={t.weldformsResults.common.loadFailed} onRetry={() => { void columnsQuery.refetch(); void list.refetch(); }} />;
  }

  const noResponsesAtAll = responses.length === 0 && filterCount === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={trr.searchPlaceholder}
          aria-label={trr.searchPlaceholder}
          className="w-full sm:w-64"
        />
        <FiltersPanel form={form} columns={columns} versions={versions.data ?? []} state={filters} onChange={setFilters} />
        <Select value={filters.sort} onValueChange={(value) => setFilters((c) => ({ ...c, sort: value as ResponsesFilterState['sort'] }))}>
          <SelectTrigger size="sm" aria-label={trr.sort} className="h-8 w-auto min-w-[9rem] shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((value) => (
              <SelectItem key={value} value={value}>
                {trr.sorts[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canDelete && selected.length > 0 && (
            <Button type="button" variant="outline" size="sm" className="h-8 text-destructive" onClick={() => setConfirmBulk(true)}>
              <Trash2 className="mr-1.5 h-4 w-4" />
              {format(trr.deleteSelected, { count: selected.length })}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-8">
                <Columns3 className="mr-1.5 h-4 w-4" />
                {trr.columns}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-auto">
              <DropdownMenuLabel>{trr.columnsHint}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {columns.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.key}
                  checked={visibleKeys.includes(column.key)}
                  onCheckedChange={(on) => toggleColumn(column, on === true)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="truncate">{column.label}</span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setVisible(null)}>{trr.resetColumns}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canExport && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-8" disabled={exporter.isPending}>
                  <Download className="mr-1.5 h-4 w-4" />
                  {trr.export}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void runExport('csv')}>{trr.exportCsv}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void runExport('xlsx')}>{trr.exportXlsx}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{format(trr.exportTooLarge, { max: FORM_LIMITS.maxExportRows })}</p>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {responses.length === 0 ? (
        noResponsesAtAll ? (
          <EmptyState icon={Inbox} title={trr.emptyTitle} description={trr.emptyDescription} />
        ) : (
          <EmptyState
            icon={Inbox}
            title={trr.noResultsTitle}
            description={trr.noResultsDescription}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setFilters(EMPTY_FILTERS);
                }}
              >
                {trr.clearFilters}
              </Button>
            }
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label={trr.selectAll}
                      checked={allSelected}
                      disabled={!canDelete}
                      onCheckedChange={(on) => setSelected(on === true ? responses.map((r) => r.id) : [])}
                    />
                  </TableHead>
                  {visibleColumns.map((column) => (
                    <TableHead key={column.key} className="whitespace-nowrap">
                      {column.label}
                    </TableHead>
                  ))}
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {responses.map((response) => (
                  <TableRow
                    key={response.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    data-state={selected.includes(response.id) ? 'selected' : undefined}
                    onClick={() => setOpenId(response.id)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        setOpenId(response.id);
                      }
                    }}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        aria-label={format(trr.selectRow, { number: response.number ?? response.id })}
                        disabled={!canDelete}
                        checked={selected.includes(response.id)}
                        onCheckedChange={(on) =>
                          setSelected((current) => (on === true ? [...new Set([...current, response.id])] : current.filter((id) => id !== response.id)))
                        }
                      />
                    </TableCell>
                    {visibleColumns.map((column) => (
                      <TableCell key={column.key} className="max-w-64 truncate">
                        {renderCell(column, response)}
                      </TableCell>
                    ))}
                    <TableCell className="whitespace-nowrap">
                      {response.status === 'in_progress' && (
                        <SoftBadge tone={response.abandoned ? 'danger' : 'warning'}>
                          {response.abandoned ? trr.abandoned : trr.partial}
                        </SoftBadge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {list.totalCount === null
                ? format(trr.showingNoTotal, { shown: responses.length })
                : format(trr.showing, { shown: responses.length, total: list.totalCount })}
            </p>
            {list.hasNextPage && (
              <Button type="button" variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t.weldformsResults.common.loadMore}
              </Button>
            )}
          </div>
        </>
      )}

      <ResponseDrawer form={form} responseId={openId} onClose={() => setOpenId(null)} />
      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={format(trr.bulkDeleteTitle, { count: selected.length })}
        description={trr.bulkDeleteDescription}
        variant="destructive"
        confirmLabel={t.weldformsResults.common.delete}
        cancelLabel={t.weldformsResults.common.cancel}
        loading={bulkDelete.isPending}
        onConfirm={() => void runBulkDelete()}
      />
    </div>
  );
}

