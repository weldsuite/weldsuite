/**
 * WeldForms home: forms as the standard list (toolbar, column header, one row
 * per form with its menu), with a folder picker and a status filter in the
 * toolbar, search, sortable columns, a New form dialog (blank, template, AI),
 * duplicate, move to a folder and delete.
 */

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Copy, EllipsisVertical, FolderInput, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { FormFolder, FormStatus, FormSummary, ListFormsQuery } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { EntityList, EmptyStateIllustration, type ActiveFilter, type FilterConfig, type HeaderColumn, type SortState } from '@/components/entity-list';
import { RowOverlayButton } from '@/components/shared/row-overlay-button';
import { formatMediumDateNow } from '@/lib/i18n/date-locale';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useDeleteForm, useDuplicateForm, useFormFolders, useForms, useMoveForm } from '@/hooks/queries/use-weldforms-queries';
import { FolderMenu, ALL_FOLDERS, NO_FOLDER } from './components/folder-menu';
import { NewFormDialog } from './components/new-form-dialog';
import { FormStatusBadge } from './components/status-badge';
import { useAiAvailable } from './lib/ai-availability';

type FormSort = NonNullable<ListFormsQuery['sort']>;

/** Sortable columns and the server sort each stands for; the server sorts one way per key. */
const COLUMN_SORT: Readonly<Record<string, { sort: FormSort; direction: SortState['direction'] }>> = {
  name: { sort: 'title', direction: 'asc' },
  responses: { sort: 'responses', direction: 'desc' },
  updated: { sort: 'updated', direction: 'desc' },
  created: { sort: 'created', direction: 'desc' },
};

const FORM_STATUSES = ['draft', 'published', 'closed'] as const satisfies readonly FormStatus[];

function isFormStatus(value: string | undefined): value is FormStatus {
  return (FORM_STATUSES as readonly string[]).includes(value ?? '');
}

/** The status filter from the filter pills: one status to ask the server for, or one to leave out. */
function statusFilter(filters: readonly ActiveFilter[]): { only?: FormStatus; except?: FormStatus } {
  const pill = filters.find((f) => f.field === 'status' && f.value);
  if (!pill || !isFormStatus(pill.value)) return {};
  return pill.operator === 'is not' ? { except: pill.value } : { only: pill.value };
}

/** The list filter for a folder choice: every form, the forms outside a folder, or one folder. */
function folderFilter(folder: string): string | undefined {
  if (folder === ALL_FOLDERS) return undefined;
  if (folder === NO_FOLDER) return 'none';
  return folder;
}

/** The folder a new form goes into: the one picked, if any. */
function folderForNewForm(folder: string): string | null {
  return folder === ALL_FOLDERS || folder === NO_FOLDER ? null : folder;
}

export default function WeldFormsHome() {
  const { t } = useI18n();
  const th = t.weldforms.home;
  const router = useRouter();
  const canCreate = useCan('forms:create');
  const canUpdate = useCan('forms:update');
  const canDelete = useCan('forms:delete');
  const aiAvailable = useAiAvailable();

  const [folder, setFolder] = useState<string>(ALL_FOLDERS);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [sortColumn, setSortColumn] = useState<keyof typeof COLUMN_SORT>('updated');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<FormSummary | null>(null);
  const [moving, setMoving] = useState<FormSummary | null>(null);

  const status = statusFilter(filters);
  const sort = COLUMN_SORT[sortColumn]!;
  const params: Omit<ListFormsQuery, 'cursor'> = {
    folderId: folderFilter(folder),
    status: status.only,
    q: deferredSearch || undefined,
    sort: sort.sort,
  };
  const query = useForms(params);
  const folders = useFormFolders();
  const duplicate = useDuplicateForm();
  const remove = useDeleteForm();

  // The server filters on one status; "is not" leaves one out of the rows loaded.
  const forms = status.except ? query.forms.filter((form) => form.status !== status.except) : query.forms;
  // When that leaves none of the loaded rows, the list has no row to scroll to and
  // never asks for more, so load the next page here until a row is left or none remain.
  // A page that fails stops it (retrying here would loop on a persistent error) and
  // shows the error in the list body, under the toolbar, so the filter can still be cleared.
  const filteredAway = Boolean(status.except) && forms.length === 0 && query.forms.length > 0;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  const searchingFurther = filteredAway && hasNextPage && !isFetchNextPageError;
  const searchFailed = filteredAway && isFetchNextPageError;
  useEffect(() => {
    if (searchingFurther && !isFetchingNextPage) void fetchNextPage();
  }, [searchingFurther, isFetchingNextPage, fetchNextPage]);
  // Every form, those outside a folder included. Unfiltered, this is the same
  // query (and cache entry) as the "All forms" list, so it costs no extra request there.
  const allForms = useForms({ sort: sort.sort });
  const totalForms = allForms.data?.pages[0]?.pagination?.totalCount ?? null;

  async function onDuplicate(form: FormSummary) {
    try {
      await duplicate.mutateAsync({ id: form.id, title: `${form.title} ${t.weldforms.actions.copySuffix}` });
      toast.success(t.weldforms.actions.duplicated);
    } catch {
      toast.error(t.weldforms.actions.duplicateFailed);
    }
  }

  async function onDelete(form: FormSummary) {
    try {
      await remove.mutateAsync(form.id);
      toast.success(t.weldforms.actions.deleted);
    } catch {
      toast.error(t.weldforms.actions.deleteFailed);
    } finally {
      setDeleting(null);
    }
  }

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      { id: 'name', header: th.columns.name, width: 'flex-1 min-w-[240px]', sortable: true },
      { id: 'status', header: th.columns.status, width: 'w-[200px]' },
      { id: 'responses', header: th.responses, width: 'w-[110px]', sortable: true },
      { id: 'lastResponse', header: th.lastResponse, width: 'hidden xl:block w-[140px]' },
      { id: 'updated', header: th.columns.updated, width: 'w-[140px]', sortable: true },
      { id: 'created', header: th.columns.created, width: 'hidden lg:block w-[140px]', sortable: true },
    ],
    [th],
  );

  const filterConfigs: FilterConfig[] = useMemo(
    () => [{ field: 'status', label: th.columns.status, options: FORM_STATUSES.map((s) => ({ value: s, label: t.weldforms.status[s] })) }],
    [th, t.weldforms.status],
  );

  const renderRow = (form: FormSummary) => {
    const title = form.title || t.weldforms.untitled;
    return (
      <div key={form.id} className="group relative flex cursor-pointer items-center gap-4 border-b border-gray-200/70 px-4 py-3 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50">
        <RowOverlayButton label={title} onClick={() => router.push(`/weldforms/${form.id}/edit`)} />
        <div className="min-w-[240px] flex-1">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{title}</p>
        </div>
        <div className="w-[200px]">
          <FormStatusBadge status={form.status} hasUnpublishedChanges={form.hasUnpublishedChanges} />
        </div>
        <div className="w-[110px]">
          <span className="text-sm tabular-nums">{form.responseCount}</span>
        </div>
        <div className="hidden w-[140px] xl:block">
          <span className={form.lastResponseAt ? 'text-sm tabular-nums' : 'text-sm text-muted-foreground'}>{form.lastResponseAt ? formatMediumDateNow(form.lastResponseAt) : th.never}</span>
        </div>
        <div className="w-[140px]">
          <span className="text-sm tabular-nums">{formatMediumDateNow(form.updatedAt)}</span>
        </div>
        <div className="hidden w-[140px] lg:block">
          <span className="text-sm tabular-nums">{formatMediumDateNow(form.createdAt)}</span>
        </div>
        {/* h-7 holds the task row's 53px height on rows without a menu too. */}
        <div className="relative z-[1] flex h-7 w-[40px] items-center justify-end">
          {(canCreate || canUpdate || canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`${t.common.actions.openMenu}: ${title}`}
                  className="h-7 w-7 p-0 text-gray-400 opacity-0 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                >
                  <EllipsisVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canCreate && (
                  <DropdownMenuItem onSelect={() => void onDuplicate(form)}>
                    <Copy className="mr-0.5 h-4 w-4" />
                    {t.weldforms.actions.duplicate}
                  </DropdownMenuItem>
                )}
                {canUpdate && (
                  <DropdownMenuItem onSelect={() => setMoving(form)}>
                    <FolderInput className="mr-0.5 h-4 w-4" />
                    {th.moveToFolder}
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <>
                    {(canCreate || canUpdate) && <DropdownMenuSeparator />}
                    <DropdownMenuItem onSelect={() => setDeleting(form)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                      <Trash2 className="mr-0.5 h-4 w-4 text-destructive" />
                      {t.common.actions.delete}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  };

  const createForm = () => setCreating(true);
  const folderMenu = <FolderMenu folders={folders.data ?? []} selected={folder} onSelect={setFolder} totalCount={totalForms} />;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The toolbar's left side is hidden on small screens; the folder picker shows here instead. */}
        <div className="border-b px-3 py-2 md:hidden">{folderMenu}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.error && !query.data ? (
            <ErrorState message={t.weldforms.loadFailed} onRetry={() => void query.refetch()} retryLabel={t.common.actions.retry} />
          ) : (
            <EntityList<FormSummary>
              items={forms}
              isLoading={query.isLoading || searchingFurther}
              error={null}
              headerColumns={headerColumns}
              filters={filterConfigs}
              activeFilters={filters}
              onFiltersChange={setFilters}
              renderRow={renderRow}
              searchPlaceholder={th.searchPlaceholder}
              searchFields={['title']}
              searchQuery={search}
              onSearchChange={setSearch}
              sortState={{ columnId: sortColumn, direction: sort.direction }}
              onSort={(columnId) => {
                if (columnId in COLUMN_SORT) setSortColumn(columnId);
              }}
              hasMore={query.hasNextPage}
              isLoadingMore={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
              topBarClassName="pt-2 pb-2"
              leftActionButtons={folderMenu}
              createButton={canCreate ? { label: th.newForm, onClick: createForm } : undefined}
              emptyState={{
                icon: <FormsIllustration />,
                // An empty folder among other forms is not "no forms yet"; AI only where it is offered.
                ...(folder === ALL_FOLDERS
                  ? { title: th.emptyTitle, description: aiAvailable ? th.emptyDescription : th.emptyDescriptionNoAi }
                  : { title: th.folderEmptyTitle, description: th.folderEmptyDescription }),
                action: canCreate ? { label: th.newForm, onClick: createForm } : undefined,
              }}
              noResultsState={
                searchFailed
                  ? { title: t.weldforms.loadFailed, description: th.loadMoreFailed, action: { label: t.common.actions.retry, onClick: () => void fetchNextPage() } }
                  : { title: th.noResultsTitle, description: th.noResultsDescription }
              }
            />
          )}
        </div>
      </div>

      <NewFormDialog open={creating} onOpenChange={setCreating} folderId={folderForNewForm(folder)} />
      <MoveDialog form={moving} folders={folders.data ?? []} onClose={() => setMoving(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t.weldforms.actions.deleteConfirmTitle}
        description={t.weldforms.actions.deleteConfirmDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        onConfirm={() => (deleting ? onDelete(deleting) : undefined)}
      />
    </div>
  );
}

function FormsIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="24" y="12" width="72" height="96" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="24" y="12" width="72" height="96" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <line x1="36" y1="30" x2="72" y2="30" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.6" />
        <rect x="36" y="38" width="48" height="10" rx="2" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" fill="none" opacity="0.5" />
        <line x1="36" y1="60" x2="64" y2="60" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.6" />
        <rect x="36" y="68" width="48" height="10" rx="2" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" fill="none" opacity="0.5" />
        <rect x="36" y="88" width="20" height="8" rx="2" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" fill="none" opacity="0.4" />
      </svg>
    </EmptyStateIllustration>
  );
}

function MoveDialog({ form, folders, onClose }: Readonly<{ form: FormSummary | null; folders: FormFolder[]; onClose: () => void }>) {
  const { t } = useI18n();
  const th = t.weldforms.home;
  const move = useMoveForm();
  const [target, setTarget] = useState<string>(NO_FOLDER);

  return (
    <Dialog
      open={form !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
        else setTarget(form?.folderId ?? NO_FOLDER);
      }}
    >
      <DialogContent className="sm:max-w-sm" onOpenAutoFocus={() => setTarget(form?.folderId ?? NO_FOLDER)}>
        <DialogHeader>
          <DialogTitle>{th.moveToFolder}</DialogTitle>
          <DialogDescription>{form?.title}</DialogDescription>
        </DialogHeader>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger aria-label={t.weldforms.folders.title}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_FOLDER}>{t.weldforms.folders.none}</SelectItem>
            {folders.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.common.actions.cancel}
          </Button>
          <Button
            type="button"
            disabled={move.isPending}
            onClick={async () => {
              if (!form) return;
              try {
                await move.mutateAsync({ id: form.id, folderId: target === NO_FOLDER ? null : target });
                toast.success(th.moved);
                onClose();
              } catch {
                toast.error(th.moveFailed);
              }
            }}
          >
            {th.move}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

