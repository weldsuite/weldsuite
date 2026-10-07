import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  History,
  Lock,
  LockOpen,
  MoreHorizontal,
  Move,
  Star,
  Trash2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Badge } from '@weldsuite/ui/components/badge';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  BlockEditor,
  type BlockEditorHandle,
  type BlockNoteEditorInstance,
} from '@/components/block-editor/block-editor';
import type { Block, PartialBlock } from '@blocknote/core';
import {
  useAddKnowledgeFavorite,
  useDeleteKnowledgePage,
  useJoinKnowledgeSpace,
  useKnowledgeFavorites,
  useKnowledgePage,
  useKnowledgePageTree,
  useKnowledgeSpaces,
  useRemoveKnowledgeFavorite,
  useSaveKnowledgePageContent,
  useUpdateKnowledgePageMeta,
} from '@/hooks/queries/use-knowledge-queries';
import { MovePageDialog } from '../components/move-page-dialog';
import { VersionHistorySheet } from '../components/version-history-sheet';

const AUTOSAVE_DELAY_MS = 1500;
/** How many of this editor's own saves to remember when recognising their echo. */
const SENT_CONTENT_HISTORY = 10;

/** Stringify with sorted object keys, so equal content matches whatever key order the server returns. */
function contentFingerprint(content: unknown): string {
  return JSON.stringify(content ?? [], (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
}

/** Recursively concatenate every `text`-ish string found in a BlockNote block tree. */
function extractText(blocks: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.text === 'string') parts.push(obj.text);
      if (obj.content) walk(obj.content);
      if (obj.children) walk(obj.children);
    }
  };
  walk(blocks);
  return parts.join(' ').trim();
}

interface PageViewProps {
  pageId: string;
}

export default function PageView({ pageId }: Readonly<PageViewProps>) {
  const t = getTranslations('weldknow');
  const router = useRouter();
  const canUpdate = useCan('knowledge:update');
  const canDelete = useCan('knowledge:delete');

  const { data: pageData, isLoading, isError } = useKnowledgePage(pageId);
  const { data: treeData } = useKnowledgePageTree();
  const { data: favoritesData } = useKnowledgeFavorites();
  const { data: spacesData } = useKnowledgeSpaces();

  const updateMeta = useUpdateKnowledgePageMeta();
  const joinSpace = useJoinKnowledgeSpace();
  const saveContent = useSaveKnowledgePageContent();
  const deletePage = useDeleteKnowledgePage();
  const addFavorite = useAddKnowledgeFavorite();
  const removeFavorite = useRemoveKnowledgeFavorite();

  const page = pageData?.data;
  const allNodes = useMemo(() => treeData?.data ?? [], [treeData]);
  const favorites = favoritesData?.data ?? [];
  const isFavorite = favorites.some((f) => f.pageId === pageId);

  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const titleSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentBlocksRef = useRef<Block[] | null>(null);
  const editorRef = useRef<BlockNoteEditorInstance | null>(null);
  const blockEditorRef = useRef<BlockEditorHandle>(null);
  // Fingerprints of the content this editor recently saved, and the server
  // content last compared against them — see the sync effect below.
  const sentContentRef = useRef<string[]>([]);
  const seenContentRef = useRef<{ pageId: string; contentJson: unknown } | null>(null);
  const [restoreCount, setRestoreCount] = useState(0);

  // Sync local title/icon state whenever a different page loads.
  useEffect(() => {
    if (page) {
      setTitle(page.title || '');
      setIcon(page.icon || '');
    }
  }, [page?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const breadcrumbAncestors = useMemo(() => {
    if (!page) return [];
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const chain: { id: string; title: string }[] = [];
    let current = byId.get(page.parentId ?? '');
    while (current) {
      chain.unshift({ id: current.id, title: current.title || t.sidebar.untitled });
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chain;
  }, [page, allNodes, t]);

  useBreadcrumbs(
    [
      { label: t.breadcrumb.home, href: '/weldknow' },
      ...breadcrumbAncestors.map((a) => ({ label: a.title, href: `/weldknow/page/${a.id}` })),
      { label: title || t.page.untitled },
    ],
    { enabled: !!page },
  );

  const flushTitleSave = useCallback(
    (nextTitle: string) => {
      if (titleSaveTimeout.current) clearTimeout(titleSaveTimeout.current);
      updateMeta.mutate(
        { id: pageId, data: { title: nextTitle.trim() || t.page.untitled } },
        { onError: () => toast.error(t.page.updateError) },
      );
    },
    [pageId, updateMeta, t],
  );

  const handleTitleChange = useCallback(
    (value: string) => {
      setTitle(value);
      if (titleSaveTimeout.current) clearTimeout(titleSaveTimeout.current);
      titleSaveTimeout.current = setTimeout(() => flushTitleSave(value), AUTOSAVE_DELAY_MS);
    },
    [flushTitleSave],
  );

  const handleContentChange = useCallback(
    (blocks: Block[]) => {
      currentBlocksRef.current = blocks;
      setSaveState('saving');
      if (contentSaveTimeout.current) clearTimeout(contentSaveTimeout.current);
      contentSaveTimeout.current = setTimeout(() => {
        contentSaveTimeout.current = null;
        const contentJson = currentBlocksRef.current as unknown as Record<string, unknown>[];
        sentContentRef.current = [
          ...sentContentRef.current.slice(1 - SENT_CONTENT_HISTORY),
          contentFingerprint(contentJson),
        ];
        saveContent.mutate(
          { id: pageId, data: { contentJson, contentText: extractText(contentJson) } },
          {
            onSuccess: () => setSaveState('saved'),
            onError: () => {
              setSaveState('idle');
              toast.error(t.page.saveContentError);
            },
          },
        );
      }, AUTOSAVE_DELAY_MS);
    },
    [pageId, saveContent, t],
  );

  // The editor owns the content once it is mounted, so snapshot it per page.
  // Passing page.contentJson straight through would hand BlockEditor a new
  // array after every refetch and make it rebuild the whole editor — closing
  // the slash menu and dropping the caret and undo history mid-edit.
  const initialContent = useMemo(
    () => (page?.contentJson ?? []) as unknown as PartialBlock[],
    [page?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Every autosave comes back as a realtime-triggered refetch. Only load server
  // content into the open editor when it is not our own save echoing back
  // (a restored version, or an edit made elsewhere), and never over unsaved edits.
  useEffect(() => {
    if (!page) return;
    const seen = seenContentRef.current;
    seenContentRef.current = { pageId: page.id, contentJson: page.contentJson };
    if (seen?.pageId !== page.id) {
      sentContentRef.current = [];
      return;
    }
    if (seen.contentJson === page.contentJson) return;
    if (contentSaveTimeout.current) return;
    if (sentContentRef.current.includes(contentFingerprint(page.contentJson))) return;
    blockEditorRef.current?.replaceContent(
      (page.contentJson ?? []) as unknown as Parameters<BlockEditorHandle['replaceContent']>[0],
    );
  }, [page?.id, page?.contentJson, restoreCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // A restored version must win over anything this editor sent or still holds.
  const handleVersionRestored = useCallback(() => {
    if (contentSaveTimeout.current) {
      clearTimeout(contentSaveTimeout.current);
      contentSaveTimeout.current = null;
    }
    sentContentRef.current = [];
    if (seenContentRef.current) seenContentRef.current.contentJson = undefined;
    setRestoreCount((count) => count + 1);
  }, []);

  // Flush any pending saves when navigating away from this page.
  useEffect(() => {
    return () => {
      if (titleSaveTimeout.current) clearTimeout(titleSaveTimeout.current);
      if (contentSaveTimeout.current) {
        clearTimeout(contentSaveTimeout.current);
        if (currentBlocksRef.current) {
          const contentJson = currentBlocksRef.current as unknown as Record<string, unknown>[];
          saveContent.mutate({ id: pageId, data: { contentJson, contentText: extractText(contentJson) } });
        }
      }
    };
  }, [pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleFavorite = useCallback(async () => {
    try {
      if (isFavorite) {
        await removeFavorite.mutateAsync(pageId);
        toast.success(t.page.unfavoriteSuccess);
      } else {
        await addFavorite.mutateAsync(pageId);
        toast.success(t.page.favoriteSuccess);
      }
    } catch {
      toast.error(t.page.favoriteError);
    }
  }, [isFavorite, pageId, addFavorite, removeFavorite, t]);

  const handleToggleLock = useCallback(async () => {
    if (!page) return;
    try {
      await updateMeta.mutateAsync({ id: pageId, data: { isLocked: !page.isLocked } });
      toast.success(page.isLocked ? t.page.unlockSuccess : t.page.lockSuccess);
    } catch {
      toast.error(t.page.updateError);
    }
  }, [page, pageId, updateMeta, t]);

  const handleDelete = useCallback(async () => {
    try {
      await deletePage.mutateAsync(pageId);
      toast.success(t.page.deleteSuccess);
      router.push('/weldknow');
    } catch {
      toast.error(t.page.deleteError);
    } finally {
      setShowDeleteConfirm(false);
    }
  }, [deletePage, pageId, router, t]);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (isError || !page) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center px-6">
        <p className="text-sm font-medium">{t.page.notFound}</p>
        <p className="text-sm text-muted-foreground">{t.page.notFoundDescription}</p>
      </div>
    );
  }

  // The workspace permission and the teamspace role must both allow writing.
  const space = spacesData?.data.find((s) => s.id === page.spaceId);
  const canWrite = canUpdate && (space?.canWrite ?? false);
  const readOnly = !canWrite || page.isLocked;
  const canJoinToEdit = !!space && !space.isMember && space.kind === 'team' && space.visibility === 'open';

  const handleJoin = async () => {
    if (!space) return;
    try {
      await joinSpace.mutateAsync(space.id);
      toast.success(t.teamspaces.joinSuccess);
    } catch {
      toast.error(t.teamspaces.joinError);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Page actions — breadcrumbs live in the shared AppHeader */}
      <div className="flex items-center justify-end gap-2 px-6 py-2">
        <div className="flex items-center gap-2 shrink-0">
          {page.isLocked && (
            <Badge variant="secondary" className="gap-1">
              <Lock className="h-3 w-3" />
              {t.page.locked}
            </Badge>
          )}
          {saveState !== 'idle' && (
            <span className="text-xs text-muted-foreground">
              {saveState === 'saving' ? t.page.saving : t.page.saved}
            </span>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleToggleFavorite}>
            <Star className={isFavorite ? 'h-4 w-4 fill-yellow-400 text-yellow-400' : 'h-4 w-4'} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setShowVersions(true)}>
                <History className="mr-2 h-4 w-4" />
                {t.page.versionHistory}
              </DropdownMenuItem>
              {canWrite && (
                <DropdownMenuItem onClick={handleToggleLock}>
                  {page.isLocked ? (
                    <LockOpen className="mr-2 h-4 w-4" />
                  ) : (
                    <Lock className="mr-2 h-4 w-4" />
                  )}
                  {page.isLocked ? t.page.unlock : t.page.lock}
                </DropdownMenuItem>
              )}
              {canWrite && (
                <DropdownMenuItem onClick={() => setShowMoveDialog(true)}>
                  <Move className="mr-2 h-4 w-4" />
                  {t.page.moveTo}
                </DropdownMenuItem>
              )}
              {canDelete && canWrite && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:text-red-600"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t.page.delete}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {page.coverImage && (
          <div className="h-40 w-full overflow-hidden">
            <img src={page.coverImage} alt="" className="h-full w-full object-cover" />
          </div>
        )}

        <div className="mx-auto max-w-[820px] px-12 pt-10 pb-24">
          <div className="mb-2 flex items-center gap-3">
            {icon && <span className="text-4xl leading-none">{icon}</span>}
            <input
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              onBlur={() => flushTitleSave(title)}
              placeholder={t.page.titlePlaceholder}
              disabled={readOnly}
              className="w-full flex-1 bg-transparent text-4xl font-bold outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed"
            />
          </div>

          {page.isLocked && (
            <p className="mb-4 text-sm text-muted-foreground">{t.page.lockedBanner}</p>
          )}

          {canJoinToEdit ? (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
              <p className="text-sm text-muted-foreground">{t.page.joinBanner}</p>
              <Button size="sm" variant="outline" onClick={handleJoin} disabled={joinSpace.isPending}>
                {t.page.joinToEdit}
              </Button>
            </div>
          ) : (
            !canWrite &&
            space && <p className="mb-4 text-sm text-muted-foreground">{t.page.readOnlyBanner}</p>
          )}

          <BlockEditor
            ref={blockEditorRef}
            key={page.id}
            initialContent={initialContent}
            editable={!readOnly}
            entityId={page.id}
            onContentChange={handleContentChange}
            onEditorReady={(editor) => {
              editorRef.current = editor;
            }}
          />
        </div>
      </div>

      <MovePageDialog pageId={pageId} open={showMoveDialog} onOpenChange={setShowMoveDialog} />

      <VersionHistorySheet
        pageId={pageId}
        open={showVersions}
        onOpenChange={setShowVersions}
        onRestored={handleVersionRestored}
        canEdit={canWrite}
      />

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={t.page.deleteTitle}
        description={t.page.deleteDescription}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={deletePage.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
