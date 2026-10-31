/**
 * Choose files from WeldDrive, for another module to use. Laid out as Google
 * Drive's picker, in the platform's own style: tabs for the recent files, My
 * Drive and its folders, what teammates shared and (with `upload`) an upload,
 * then the platform's standard list. Mount it while it is open, so every
 * opening starts empty. `onConfirm` gets the chosen files; the dialog stays
 * open, with its button busy, until that settles.
 */

import { useDeferredValue, useRef, useState, type DragEvent } from 'react';
import { ChevronRight, Clock, Folder, HardDrive, Loader2, Search, Upload, Users } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { EntityList, type GroupConfig, type HeaderColumn } from '@/components/entity-list';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { FilesIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { useDriveFiles, useDriveFolders, useSharedWithMe } from '@/hooks/queries/use-drive-queries';
import type { DriveFolder, UnifiedFile } from '@/lib/api/domains/welddrive';
import { getAppIcon } from '@/lib/apps/app-registry';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { fileTypeIcons, formatDate, formatFileSize } from './drive-file-card';

/** Files asked for at once; a search narrows the rest down. */
const PAGE_SIZE = 100;

type Tab = 'recent' | 'myDrive' | 'shared' | 'upload';
type Strings = ReturnType<typeof useI18n>['t']['welddrive']['picker']['files'];
/** A row of the list: a folder, which opens, or a file, which can be chosen. */
type Item = { id: string; folder: DriveFolder; file?: never } | { id: string; file: UnifiedFile; folder?: never };

interface DriveFilePickerDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  /** The confirm button while `onConfirm` runs. */
  pendingLabel: string;
  /** The Drive file type to list, such as `pdf`. */
  fileType: string;
  /** Leaves out files of that type that still do not fit. */
  accept?: (file: UnifiedFile) => boolean;
  /** How many files may be chosen; unlimited when left out. */
  maxSelect?: number;
  /** Adds an Upload tab: files dropped or chosen there go to `onFiles`, and the dialog closes. */
  upload?: { accept: string; onFiles: (files: File[]) => void };
  onConfirm: (files: UnifiedFile[]) => Promise<void>;
  onClose: () => void;
}

export function DriveFilePickerDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  fileType,
  accept,
  maxSelect,
  upload,
  onConfirm,
  onClose,
}: Readonly<DriveFilePickerDialogProps>) {
  const { t } = useI18n();
  const tp = t.welddrive.picker.files;
  const [tab, setTab] = useState<Tab>('recent');
  const [path, setPath] = useState<Pick<DriveFolder, 'id' | 'name'>[]>([]);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<ReadonlyMap<string, UnifiedFile>>(new Map());
  const [pending, setPending] = useState(false);
  const deferredSearch = useDeferredValue(search.trim());

  const folderId = path.at(-1)?.id;
  const content = usePickerListing({ fileType, accept, tab, folderId, search: deferredSearch });
  const full = maxSelect !== undefined && chosen.size >= maxSelect;

  const selectTab = (next: Tab) => {
    setTab(next);
    setPath([]);
    setSearch('');
  };

  const toggle = (file: UnifiedFile) =>
    setChosen((previous) => {
      const next = new Map(previous);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file);
      return next;
    });

  async function confirm() {
    setPending(true);
    try {
      await onConfirm([...chosen.values()]);
    } finally {
      setPending(false);
      onClose();
    }
  }

  const tabs: PageTab[] = [
    { id: 'recent', label: tp.tabs.recent, icon: Clock },
    { id: 'myDrive', label: tp.tabs.myDrive, icon: HardDrive },
    { id: 'shared', label: tp.tabs.shared, icon: Users },
    ...(upload ? [{ id: 'upload', label: tp.tabs.upload, icon: Upload }] : []),
  ];
  const uploading = tab === 'upload' && !deferredSearch;
  const browsing = !deferredSearch && (tab === 'myDrive' || tab === 'shared');

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="flex h-[min(640px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <div className="flex items-center gap-2.5 px-4 pt-5 pb-4 pr-14">
          <img src={getAppIcon('welddrive')} alt="" className="size-5" />
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </div>

        <PageTabs tabs={tabs} activeTab={tab} onTabChange={(id) => selectTab(id as Tab)} innerClassName="px-4" />

        {!(uploading && upload) && (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            {browsing ? (
              <Breadcrumb root={tab === 'shared' ? tp.tabs.shared : tp.tabs.myDrive} path={path} onOpen={(depth) => setPath(path.slice(0, depth))} />
            ) : (
              <span />
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label={tp.searchPlaceholder}
                placeholder={tp.searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-56 pl-8 text-sm shadow-none md:text-sm"
              />
            </div>
          </div>
        )}

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
          {uploading && upload ? (
            <UploadPane
              accept={upload.accept}
              onFiles={(files) => {
                upload.onFiles(files);
                onClose();
              }}
            />
          ) : (
            <PickerList
              {...content}
              searching={!!deferredSearch}
              chosen={chosen}
              full={full}
              disabled={pending}
              onToggle={toggle}
              onOpenFolder={(folder) => setPath([...path, { id: folder.id, name: folder.name }])}
              onUpload={upload ? () => selectTab('upload') : undefined}
            />
          )}
        </div>

        <PickerFooter
          count={chosen.size}
          maxSelect={maxSelect}
          pending={pending}
          confirmLabel={confirmLabel}
          pendingLabel={pendingLabel}
          onCancel={onClose}
          onConfirm={() => void confirm()}
        />
      </DialogContent>
    </Dialog>
  );
}

interface PickerFooterProps {
  count: number;
  maxSelect?: number;
  pending: boolean;
  confirmLabel: string;
  pendingLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** How many files are chosen, Cancel, and the confirm button, busy while it works. */
function PickerFooter({ count, maxSelect, pending, confirmLabel, pendingLabel, onCancel, onConfirm }: Readonly<PickerFooterProps>) {
  const { t, format } = useI18n();
  const tp = t.welddrive.picker.files;
  return (
    <footer className="flex items-center justify-between gap-4 border-t px-4 py-4">
      <span className="text-sm text-muted-foreground">
        {maxSelect === undefined ? format(tp.selected, { count }) : format(tp.selectedOf, { count, max: maxSelect })}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" disabled={pending} onClick={onCancel}>
          {t.common.actions.cancel}
        </Button>
        <Button disabled={pending || count === 0} onClick={onConfirm}>
          {pending && <Loader2 className="animate-spin" />}
          {pending ? pendingLabel : confirmLabel}
        </Button>
      </div>
    </footer>
  );
}

/** What a tab lists, and whether that is still loading. */
interface Listing {
  files: UnifiedFile[];
  folders: DriveFolder[];
  loading: boolean;
  failed: boolean;
  /** More files exist than were asked for. */
  limited: boolean;
  /** Under date headings, as the recent files are. */
  grouped: boolean;
}

interface ListingInput {
  fileType: string;
  accept?: (file: UnifiedFile) => boolean;
  tab: Tab;
  /** The folder opened in My Drive or Shared with me. */
  folderId?: string;
  search: string;
}

/** What the open tab, or a search, lists: the queries it takes, and their files narrowed down. */
function usePickerListing({ fileType, accept, tab, folderId, search }: Readonly<ListingInput>): Listing {
  const allParams = { type: fileType, search: search || undefined, pageSize: PAGE_SIZE };
  const all = useDriveFiles(allParams);
  // Outside a folder this is the same query as `all`, so it is not asked for twice.
  const inFolder = useDriveFiles(folderId ? { type: fileType, folderId, pageSize: PAGE_SIZE } : allParams);
  const showsFolders = !search && (tab === 'myDrive' || (tab === 'shared' && !!folderId));
  const folders = useDriveFolders(folderId ?? null, showsFolders);
  const shared = useSharedWithMe(tab === 'shared' && !folderId);
  const fits = (file: UnifiedFile) => accept?.(file) ?? true;

  if (search || tab === 'recent') {
    const recent = listingOf(all, fits);
    return { ...recent, files: newestFirst(recent.files), grouped: !search };
  }
  if (folderId) return withFolders(listingOf(inFolder, fits), folders);
  if (tab === 'shared') return sharedListing(shared, (file) => file.fileType === fileType && fits(file));
  return withFolders(listingOf(all, (file) => !file.folderId && fits(file)), folders);
}

function listingOf(query: ReturnType<typeof useDriveFiles>, keep: (file: UnifiedFile) => boolean): Listing {
  return {
    files: (query.data?.data ?? []).filter(keep),
    folders: [],
    loading: query.isLoading,
    failed: query.isError,
    limited: query.data?.pagination?.hasMore === true,
    grouped: false,
  };
}

function withFolders(listing: Listing, folders: ReturnType<typeof useDriveFolders>): Listing {
  return {
    ...listing,
    folders: folders.data?.data ?? [],
    loading: listing.loading || folders.isLoading,
    failed: listing.failed || folders.isError,
  };
}

function sharedListing(shared: ReturnType<typeof useSharedWithMe>, keep: (file: UnifiedFile) => boolean): Listing {
  return {
    files: (shared.data?.files ?? []).filter(keep),
    folders: shared.data?.folders ?? [],
    loading: shared.isLoading,
    failed: shared.isError,
    limited: false,
    grouped: false,
  };
}

const stampOf = (file: UnifiedFile) => file.updatedAt ?? file.createdAt;

function newestFirst(files: UnifiedFile[]): UnifiedFile[] {
  return [...files].sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
}

type Group = keyof Strings['groups'];
const GROUPS: Group[] = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'thisYear', 'older'];

/** Which heading of the recent files a date falls under, as Google Drive's picker groups them. */
function groupOf(iso: string, now: Date): Group {
  const date = new Date(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86_400_000;
  if (date >= today) return 'today';
  if (date.getTime() >= today.getTime() - day) return 'yesterday';
  // Weeks start on Monday.
  if (date.getTime() >= today.getTime() - ((today.getDay() + 6) % 7) * day) return 'thisWeek';
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'thisMonth';
  if (date.getFullYear() === now.getFullYear()) return 'thisYear';
  return 'older';
}

/** The list's columns: the name, then when it last changed and its size. */
const COLUMN = {
  name: 'min-w-0 flex-1',
  modified: 'w-[140px] @max-[560px]:hidden',
  size: 'w-[90px]',
};

interface PickerListProps extends Listing {
  searching: boolean;
  chosen: ReadonlyMap<string, UnifiedFile>;
  /** The selection is at its limit: files not chosen can not be added. */
  full: boolean;
  disabled: boolean;
  onToggle: (file: UnifiedFile) => void;
  onOpenFolder: (folder: DriveFolder) => void;
  /** Opens the Upload tab, from the empty state. */
  onUpload?: () => void;
}

function PickerList({ files, folders, loading, failed, limited, grouped, searching, chosen, full, disabled, onToggle, onOpenFolder, onUpload }: Readonly<PickerListProps>) {
  const { t, format } = useI18n();
  const tp = t.welddrive.picker.files;

  if (loading) {
    return (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {tp.loading}
      </p>
    );
  }
  if (failed) return <p className="py-16 text-center text-sm text-destructive">{tp.loadFailed}</p>;
  if (files.length === 0 && folders.length === 0) {
    return (
      <TabEmptyState
        bare
        illustration={<FilesIllustration />}
        title={tp.empty}
        description={searching ? tp.emptySearchHint : tp.emptyHint}
        action={onUpload && !searching ? { label: tp.tabs.upload, onClick: onUpload } : undefined}
      />
    );
  }

  const items: Item[] = [...folders.map((folder) => ({ id: folder.id, folder })), ...files.map((file) => ({ id: file.id, file }))];
  const header: HeaderColumn[] = [
    { id: 'name', header: tp.columns.name, width: COLUMN.name },
    { id: 'modified', header: tp.columns.modified, width: COLUMN.modified },
    { id: 'size', header: tp.columns.size, width: COLUMN.size },
  ];
  const now = new Date();
  const groups: GroupConfig<Item>[] | undefined = grouped
    ? GROUPS.map((group, index) => ({
        id: group,
        label: tp.groups[group],
        filter: (item: Item) => !!item.file && groupOf(stampOf(item.file), now) === group,
        sortOrder: index,
      }))
    : undefined;

  return (
    <>
      <div className="border-b border-gray-200/70 dark:border-border">
        <TabListScope>
          <EntityList<Item>
            items={items}
            isLoading={false}
            headerColumns={header}
            groups={groups}
            filters={[]}
            hideTopBar
            renderRow={(item) =>
              item.folder ? (
                <FolderRow key={item.id} folder={item.folder} onOpen={() => onOpenFolder(item.folder)} />
              ) : (
                <FileRow key={item.id} file={item.file} chosen={chosen} full={full} disabled={disabled} onToggle={onToggle} />
              )
            }
          />
        </TabListScope>
      </div>
      {limited && <p className="px-4 py-3 text-xs text-muted-foreground">{format(tp.limited, { count: PAGE_SIZE })}</p>}
    </>
  );
}

interface FileRowProps {
  file: UnifiedFile;
  chosen: ReadonlyMap<string, UnifiedFile>;
  full: boolean;
  disabled: boolean;
  onToggle: (file: UnifiedFile) => void;
}

/** A file: a click on the row, or its checkbox, chooses it. */
function FileRow({ file, chosen, full, disabled, onToggle }: Readonly<FileRowProps>) {
  const checked = chosen.has(file.id);
  const blocked = disabled || (full && !checked);
  const { icon: Icon, color } = fileTypeIcons[file.fileType] ?? fileTypeIcons.file!;
  return (
    <TabListRow label={file.name} onOpen={blocked ? undefined : () => onToggle(file)} className={cn(checked && 'bg-primary/5 dark:bg-primary/10', blocked && 'opacity-50')}>
      <div className={cn(COLUMN.name, 'flex items-center gap-3')}>
        <Checkbox className="relative z-[1]" checked={checked} disabled={blocked} aria-label={file.name} onCheckedChange={() => onToggle(file)} />
        <Icon className={cn('size-4 shrink-0', color)} />
        <span className="truncate text-sm font-medium text-foreground" title={file.name}>
          {file.name}
        </span>
      </div>
      <div className={cn(COLUMN.modified, 'truncate text-sm text-muted-foreground')}>{formatDate(stampOf(file))}</div>
      <div className={cn(COLUMN.size, 'truncate text-sm text-muted-foreground tabular-nums')}>{formatFileSize(file.fileSize)}</div>
    </TabListRow>
  );
}

const folderColor = (folder: DriveFolder) => (folder.color ? `text-${folder.color}-500` : 'text-blue-500');

/** A folder: a click opens it in place. */
function FolderRow({ folder, onOpen }: Readonly<{ folder: DriveFolder; onOpen: () => void }>) {
  return (
    <TabListRow label={folder.name} onOpen={onOpen}>
      <div className={cn(COLUMN.name, 'flex items-center gap-3')}>
        {/* The width of a checkbox, so folder and file names line up. */}
        <span className="size-4 shrink-0" />
        <Folder className={cn('size-4 shrink-0', folderColor(folder))} fill="currentColor" strokeWidth={1} />
        <span className="truncate text-sm font-medium text-foreground" title={folder.name}>
          {folder.name}
        </span>
      </div>
      <div className={cn(COLUMN.modified, 'truncate text-sm text-muted-foreground')}>{formatDate(folder.updatedAt)}</div>
      <div className={cn(COLUMN.size, 'text-sm text-muted-foreground')}>—</div>
    </TabListRow>
  );
}

/** Where in My Drive (or Shared with me) the files are from; every step but the last opens it. */
function Breadcrumb({ root, path, onOpen }: Readonly<{ root: string; path: Pick<DriveFolder, 'id' | 'name'>[]; onOpen: (depth: number) => void }>) {
  const steps = [{ id: 'root', name: root }, ...path];
  return (
    <nav className="-ml-1 flex min-w-0 items-center gap-0.5 text-sm">
      {steps.map((step, depth) => {
        const last = depth === steps.length - 1;
        return (
          <span key={step.id} className="flex min-w-0 items-center gap-0.5">
            {depth > 0 && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
            {last ? (
              <span className="truncate px-1 font-medium text-foreground">{step.name}</span>
            ) : (
              <button type="button" onClick={() => onOpen(depth)} className="truncate rounded-md px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                {step.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** The Upload tab: drop files on it, or browse for them. */
function UploadPane({ accept, onFiles }: Readonly<{ accept: string; onFiles: (files: File[]) => void }>) {
  const { t } = useI18n();
  const tu = t.welddrive.picker.files.upload;
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length > 0) onFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="h-full p-4">
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex h-full items-center justify-center rounded-xl border-2 border-dashed transition-colors',
          over ? 'border-primary bg-primary/5' : 'border-border',
        )}
      >
        <TabEmptyState
          bare
          illustration={<FilesIllustration />}
          title={tu.drop}
          description={tu.hint}
          action={{ label: tu.browse, onClick: () => inputRef.current?.click() }}
        />
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length > 0) onFiles(files);
          }}
        />
      </div>
    </div>
  );
}
