/**
 * WeldForms home: forms by folder with status, responses and last response,
 * search, sort, a New form dialog (blank, template, AI), duplicate, move to a
 * folder, delete, and the month's response usage.
 */

import { useDeferredValue, useState } from 'react';
import { ClipboardList, Copy, FolderInput, LayoutGrid, List, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { FormFolder, FormStatus, FormSummary, ListFormsQuery } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Progress } from '@weldsuite/ui/components/progress';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useDeleteForm, useDuplicateForm, useFormFolders, useForms, useFormsUsage, useMoveForm } from '@/hooks/queries/use-weldforms-queries';
import { FolderRail, ALL_FOLDERS, NO_FOLDER } from './components/folder-rail';
import { NewFormDialog } from './components/new-form-dialog';
import { FormStatusBadge } from './components/status-badge';

type ViewMode = 'grid' | 'list';
const VIEW_KEY = 'weldforms:home-view';

function loadView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export default function WeldFormsHome() {
  const { t, format, language } = useI18n();
  const th = t.weldforms.home;
  const router = useRouter();
  const canCreate = useCan('forms:create');
  const canUpdate = useCan('forms:update');
  const canDelete = useCan('forms:delete');

  const [folder, setFolder] = useState<string>(ALL_FOLDERS);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [status, setStatus] = useState<FormStatus | undefined>();
  const [sort, setSort] = useState<NonNullable<ListFormsQuery['sort']>>('updated');
  const [view, setView] = useState<ViewMode>(loadView);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<FormSummary | null>(null);
  const [moving, setMoving] = useState<FormSummary | null>(null);

  const params: Omit<ListFormsQuery, 'cursor'> = {
    folderId: folder === ALL_FOLDERS ? undefined : folder === NO_FOLDER ? 'none' : folder,
    status,
    q: deferredSearch || undefined,
    sort,
  };
  const query = useForms(params);
  const folders = useFormFolders();
  const usage = useFormsUsage();
  const duplicate = useDuplicateForm();
  const remove = useDeleteForm();

  const open = (form: Pick<FormSummary, 'id'>) => router.push(`/weldforms/${form.id}/edit`);
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
  // Every form, those outside a folder included. Unfiltered, this is the same
  // query (and cache entry) as the "All forms" list, so it costs no extra request there.
  const allForms = useForms({ sort });
  const totalForms = allForms.data?.pages[0]?.pagination?.totalCount ?? null;
  const filtered = deferredSearch !== '' || status !== undefined;

  function changeView(next: ViewMode) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not remembered; the choice still holds for this visit.
    }
  }

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

  const menu = (form: FormSummary) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`${t.common.actions.openMenu}: ${form.title}`} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => open(form)}>{th.open}</DropdownMenuItem>
        {canCreate && (
          <DropdownMenuItem onSelect={() => void onDuplicate(form)}>
            <Copy className="size-4" />
            {t.weldforms.actions.duplicate}
          </DropdownMenuItem>
        )}
        {canUpdate && (
          <DropdownMenuItem onSelect={() => setMoving(form)}>
            <FolderInput className="size-4" />
            {th.moveToFolder}
          </DropdownMenuItem>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(form)}>
              <Trash2 className="size-4" />
              {t.common.actions.delete}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const stats = (form: FormSummary) => (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      <div>
        <dt className="text-muted-foreground">{th.responses}</dt>
        <dd className="font-medium tabular-nums">{form.responseCount}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{th.lastResponse}</dt>
        <dd className="font-medium">{form.lastResponseAt ? dateFormat.format(new Date(form.lastResponseAt)) : th.never}</dd>
      </div>
    </dl>
  );

  const usageLine = usage.data && (
    <div className="flex min-w-48 flex-col gap-1" aria-label={th.usage}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{th.usage}</span>
        <span className="tabular-nums">{usage.data.limit === null ? format(th.usageUnlimited, { used: usage.data.used }) : format(th.usageOf, { used: usage.data.used, limit: usage.data.limit })}</span>
      </div>
      {usage.data.limit !== null && <Progress value={Math.min(100, (usage.data.used / Math.max(1, usage.data.limit)) * 100)} className="h-1.5" aria-label={th.usage} />}
    </div>
  );

  let body: React.ReactNode;
  if (query.isLoading) body = <PageLoader fullScreen={false} />;
  else if (query.error) body = <ErrorState message={t.weldforms.loadFailed} onRetry={() => void query.refetch()} retryLabel={t.common.actions.retry} />;
  else if (query.forms.length === 0) {
    body = (
      <EmptyState
        icon={ClipboardList}
        title={filtered ? th.noResultsTitle : th.emptyTitle}
        description={filtered ? th.noResultsDescription : th.emptyDescription}
        action={
          !filtered && canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              {th.newForm}
            </Button>
          ) : undefined
        }
      />
    );
  } else if (view === 'grid') {
    body = (
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {query.forms.map((form) => (
          <li key={form.id} className="group relative flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40">
            <div className="flex items-start justify-between gap-2">
              <button type="button" onClick={() => open(form)} className="min-w-0 flex-1 text-left after:absolute after:inset-0 after:content-['']">
                <h3 className="truncate text-sm font-semibold">{form.title || t.weldforms.untitled}</h3>
              </button>
              <div className="relative z-10">{menu(form)}</div>
            </div>
            <FormStatusBadge status={form.status} hasUnpublishedChanges={form.hasUnpublishedChanges} />
            {stats(form)}
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul className="divide-y rounded-lg border bg-card">
        {query.forms.map((form) => (
          <li key={form.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/40">
            <button type="button" onClick={() => open(form)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm font-medium">{form.title || t.weldforms.untitled}</span>
              <span className="block text-xs text-muted-foreground">
                {format(th.responsesCount, { count: form.responseCount })} · {form.lastResponseAt ? dateFormat.format(new Date(form.lastResponseAt)) : th.never}
              </span>
            </button>
            <FormStatusBadge status={form.status} hasUnpublishedChanges={form.hasUnpublishedChanges} />
            {menu(form)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-60 shrink-0 border-r md:block">
        <FolderRail folders={folders.data ?? []} selected={folder} onSelect={setFolder} totalCount={totalForms} />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="md:hidden">
            <FolderSelect folders={folders.data ?? []} value={folder} onChange={setFolder} />
          </div>
          <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder={th.searchPlaceholder} className="w-full max-w-64 sm:w-64" aria-label={th.searchPlaceholder} />
          <FilterSelect
            value={status}
            onChange={(v) => setStatus(v as FormStatus | undefined)}
            options={(['draft', 'published', 'closed'] as const).map((s) => ({ value: s, label: t.weldforms.status[s] }))}
            allLabel={th.allStatuses}
            ariaLabel={th.statusFilter}
          />
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger size="sm" className="h-8 w-auto min-w-36 shadow-none" aria-label={th.sortBy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['updated', 'created', 'title', 'responses'] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {th.sort[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden lg:block">{usageLine}</div>
            <ToggleGroup type="single" size="sm" variant="outline" value={view} onValueChange={(v) => v && changeView(v as ViewMode)} aria-label={th.view}>
              <ToggleGroupItem value="grid" aria-label={th.viewGrid}>
                <LayoutGrid className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label={th.viewList}>
                <List className="size-4" />
              </ToggleGroupItem>
            </ToggleGroup>
            {canCreate && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                {th.newForm}
              </Button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-3 lg:hidden">{usageLine}</div>
          {body}
          {query.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" size="sm" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {th.loadMore}
              </Button>
            </div>
          )}
        </div>
      </div>

      <NewFormDialog open={creating} onOpenChange={setCreating} folderId={folder === ALL_FOLDERS || folder === NO_FOLDER ? null : folder} />
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

function FolderSelect({ folders, value, onChange }: Readonly<{ folders: FormFolder[]; value: string; onChange: (id: string) => void }>) {
  const { t } = useI18n();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-8 w-auto min-w-32 shadow-none" aria-label={t.weldforms.folders.title}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_FOLDERS}>{t.weldforms.folders.all}</SelectItem>
        {folders.map((f) => (
          <SelectItem key={f.id} value={f.id}>
            {f.name}
          </SelectItem>
        ))}
        <SelectItem value={NO_FOLDER}>{t.weldforms.folders.none}</SelectItem>
      </SelectContent>
    </Select>
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

