import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { Trash2, EllipsisVertical, Pencil, FileText, Pin, PinOff } from 'lucide-react';
import { isToday, isYesterday, isThisWeek, isThisMonth, subMonths, isAfter } from 'date-fns';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig } from '@/components/entity-list';
import { useParams, useRouter } from '@/lib/router';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { documentsApi } from '@/app/weldflow/lib/api-client';
import { PageLoader } from '@/components/page-loader';
import { toast } from 'sonner';

interface DocumentItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Workspace-wide pin — pinned docs lift out of the date groups entirely. */
  isPinned: boolean;
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function ProjectDocumentsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const { canWrite } = useProjectPermissions();
  const { t } = useI18n();

  const [items, setItems] = useState<DocumentItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Each document has its own dedicated route — `/.../documents/[fileId]` —
  // which mounts the in-app BlockNote editor. Opening a doc is just a
  // navigation, matching the sheets and whiteboard surfaces.
  const openDocument = useCallback(
    (id: string) => {
      router.push(`/weldflow/project/${projectId}/documents/${id}`);
    },
    [router, projectId],
  );

  // Create dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newDocName, setNewDocName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);

  // Rename dialog
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDocId, setRenameDocId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    setIsLoading(true);
    const result = await documentsApi.listDocuments(projectId);
    if (result.success && result.data) {
      setItems(result.data);
    }
    setIsLoading(false);
  }, [projectId]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const filterConfigs: FilterConfig[] = useMemo(() => [], []);

  const groupConfigs: GroupConfig<DocumentItem>[] = useMemo(() => {
    const now = new Date();
    const oneMonthAgo = subMonths(now, 1);
    const threeMonthsAgo = subMonths(now, 3);

    // Pinned docs sit in their own group above everything and are excluded from
    // every date group, so a doc never appears twice in the list.
    return [
      { id: 'pinned', label: t.projects.documents.groupPinned, filter: (d) => d.isPinned, sortOrder: -1 },
      { id: 'today', label: t.projects.documents.groupToday, filter: (d) => !d.isPinned && isToday(new Date(d.updatedAt)), sortOrder: 0 },
      { id: 'yesterday', label: t.projects.documents.groupYesterday, filter: (d) => !d.isPinned && isYesterday(new Date(d.updatedAt)), sortOrder: 1 },
      {
        id: 'this-week', label: t.projects.documents.groupThisWeek, sortOrder: 2,
        filter: (d) => { const date = new Date(d.updatedAt); return !d.isPinned && isThisWeek(date, { weekStartsOn: 1 }) && !isToday(date) && !isYesterday(date); },
      },
      {
        id: 'this-month', label: t.projects.documents.groupThisMonth, sortOrder: 3,
        filter: (d) => { const date = new Date(d.updatedAt); return !d.isPinned && isThisMonth(date) && !isThisWeek(date, { weekStartsOn: 1 }); },
      },
      {
        id: 'last-month', label: t.projects.documents.groupLastMonth, sortOrder: 4,
        filter: (d) => { const date = new Date(d.updatedAt); return !d.isPinned && !isThisMonth(date) && isAfter(date, oneMonthAgo); },
      },
      {
        id: 'last-3-months', label: t.projects.documents.groupLast3Months, sortOrder: 5,
        filter: (d) => { const date = new Date(d.updatedAt); return !d.isPinned && !isAfter(date, oneMonthAgo) && isAfter(date, threeMonthsAgo); },
      },
      { id: 'older', label: t.projects.documents.groupOlder, filter: (d) => !d.isPinned && !isAfter(new Date(d.updatedAt), threeMonthsAgo), sortOrder: 6 },
    ];
  }, [t]);

  const applyFilters = useCallback((items: DocumentItem[]) => {
    return items;
  }, []);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.projects.documents.headerDocumentName, width: 'flex-1 min-w-[300px]' },
    { id: 'updated', header: t.projects.documents.headerDocumentUpdated, width: 'w-[140px]' },
    { id: 'created', header: t.projects.documents.headerDocumentCreated, width: 'w-[140px]' },
  ], [t]);

  const handleDeleteDocument = useCallback(async (docId: string) => {
    const result = await documentsApi.deleteDocument(projectId, docId);
    if (result.success) {
      setItems((prev) => prev.filter((d) => d.id !== docId));
      toast.success(t.projects.documents.documentDeleted2);
    } else {
      toast.error(t.projects.documents.failedToDeleteDocument);
    }
  }, [projectId, t]);

  const handleTogglePin = useCallback(async (item: DocumentItem) => {
    const next = !item.isPinned;
    // Optimistic — the row jumps between groups immediately, and we roll back
    // if the server rejects it.
    setItems((prev) => prev.map((d) => d.id === item.id ? { ...d, isPinned: next } : d));
    const result = await documentsApi.pinDocument(projectId, item.id);
    if (result.success) {
      toast.success(next ? t.projects.documents.documentPinned : t.projects.documents.documentUnpinned);
    } else {
      setItems((prev) => prev.map((d) => d.id === item.id ? { ...d, isPinned: item.isPinned } : d));
      toast.error(next ? t.projects.documents.failedToPinDocument : t.projects.documents.failedToUnpinDocument);
    }
  }, [projectId, t]);

  const openRenameDialog = useCallback((item: DocumentItem) => {
    setRenameDocId(item.id);
    setRenameValue(item.name);
    setRenameDialogOpen(true);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }, []);

  const handleRenameDocument = useCallback(async () => {
    if (!renameDocId || !renameValue.trim()) return;
    setIsRenaming(true);
    const result = await documentsApi.updateDocument(projectId, renameDocId, { name: renameValue.trim() });
    setIsRenaming(false);
    if (result.success) {
      setItems((prev) => prev.map((d) => d.id === renameDocId ? { ...d, name: renameValue.trim() } : d));
      setRenameDialogOpen(false);
      toast.success(t.projects.documents.documentRenamed);
    } else {
      toast.error(t.projects.documents.failedToRenameDocument);
    }
  }, [projectId, renameDocId, renameValue, t]);

  const renderRow = useCallback((item: DocumentItem) => {
    return (
      <div
        key={item.id}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
        onClick={() => openDocument(item.id)}
      >
        <div className="flex-1 min-w-[300px] flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
            {item.name || t.projects.documents.untitledDocument}
          </p>
          {item.isPinned && (
            <Pin className="h-3.5 w-3.5 shrink-0 fill-current text-muted-foreground" aria-label={t.projects.documents.pinnedAriaLabel} />
          )}
        </div>

        <div className="w-[140px]">
          <span className="text-sm text-gray-500">{formatDate(item.updatedAt)}</span>
        </div>

        <div className="w-[140px]">
          <span className="text-sm text-gray-500">{formatDate(item.createdAt)}</span>
        </div>

        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 text-gray-400 hover:text-gray-600"
              >
                <EllipsisVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canWrite && (
                <DropdownMenuItem onClick={() => handleTogglePin(item)}>
                  {item.isPinned ? (
                    <PinOff className="h-4 w-4 mr-0.5" />
                  ) : (
                    <Pin className="h-4 w-4 mr-0.5" />
                  )}
                  {item.isPinned ? t.projects.documents.unpinDocument : t.projects.documents.pinDocument}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => openRenameDialog(item)}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.projects.documents.renameDocument}
              </DropdownMenuItem>
              {canWrite && (
                <DropdownMenuItem
                  onClick={() => handleDeleteDocument(item.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4 mr-0.5 text-destructive" />
                  {t.projects.documents.deleteDocument}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [canWrite, handleDeleteDocument, handleTogglePin, openDocument, openRenameDialog, t]);

  const openCreateDialog = () => {
    setNewDocName('');
    setCreateDialogOpen(true);
    setTimeout(() => createInputRef.current?.focus(), 0);
  };

  const handleCreateDocument = async () => {
    const name = newDocName.trim() || t.projects.documents.untitledDocument;
    setIsCreating(true);
    const result = await documentsApi.createDocument(projectId, { name });
    setIsCreating(false);
    if (result.success && result.data) {
      setCreateDialogOpen(false);
      openDocument(result.data.id);
    } else {
      toast.error(t.projects.documents.failedToCreateDocument);
    }
  };

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <>
      <EntityList<DocumentItem>
        items={items}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={3}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={t.projects.documents.searchDocumentsPlaceholder}
        searchFields={['name']}
        topBarClassName="pt-2 pb-2"
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
        createButton={canWrite ? {
          label: t.projects.documents.newDocument,
          onClick: openCreateDialog,
        } : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration width={260} height={170}>
              <svg width="150" height="120" viewBox="0 0 150 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginLeft: 3 }}>
                {/* Back page */}
                <rect x="38" y="14" width="74" height="92" rx="6" className="fill-white dark:fill-white/[0.03]" />
                <rect x="38" y="14" width="74" height="92" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Front page */}
                <rect x="28" y="22" width="74" height="92" rx="6" className="fill-white dark:fill-white/[0.04]" />
                <rect x="28" y="22" width="74" height="92" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Title line */}
                <rect x="38" y="40" width="54" height="5" rx="2" className="fill-gray-300 dark:fill-white/25" />
                {/* Body lines */}
                <rect x="38" y="54" width="52" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.8" />
                <rect x="38" y="63" width="48" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.8" />
                <rect x="38" y="72" width="44" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.8" />
                <rect x="38" y="81" width="50" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
                <rect x="38" y="90" width="34" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.4" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t.projects.documents.noDocumentsTitle,
          description: t.projects.documents.noDocumentsDesc,
          action: canWrite ? {
            label: t.projects.documents.newDocument,
            onClick: openCreateDialog,
          } : undefined,
        }}
        noResultsState={{
          title: t.projects.documents.noDocumentsTitle,
          description: t.projects.documents.noDocumentsResultsDesc,
        }}
      />

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.documents.createDialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="doc-name">{t.projects.documents.documentNameLabel}</Label>
              <Input
                id="doc-name"
                ref={createInputRef}
                placeholder={t.projects.documents.documentNamePlaceholder}
                value={newDocName}
                onChange={(e) => setNewDocName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreateDocument();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {t.projects.documents.cancelBtn}
            </Button>
            <Button onClick={handleCreateDocument} disabled={isCreating}>
              {isCreating ? t.projects.documents.creatingDocumentBtn : t.projects.documents.createDocBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.documents.renameDocumentDialogTitle}</DialogTitle>
            <DialogDescription>
              {t.projects.documents.renameDocumentDialogDesc}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="rename-doc">{t.projects.documents.documentNameLabel}</Label>
              <Input
                id="rename-doc"
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isRenaming) {
                    handleRenameDocument();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              {t.projects.documents.cancelBtn}
            </Button>
            <Button onClick={handleRenameDocument} disabled={isRenaming}>
              {isRenaming ? t.projects.documents.savingBtn : t.projects.documents.saveBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
