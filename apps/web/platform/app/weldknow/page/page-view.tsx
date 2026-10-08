import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  BlockEditor,
  type BlockEditorHandle,
  type BlockNoteEditorInstance,
} from '@/components/block-editor/block-editor';
import type { PageLinkSource } from '@/components/block-editor/slash-menu';
import type { Block, PartialBlock } from '@blocknote/core';
import {
  useCreateKnowledgePage,
  useJoinKnowledgeSpace,
  useKnowledgePage,
  useKnowledgePageTree,
  useKnowledgeSpaces,
  useSaveKnowledgePageContent,
  useUpdateKnowledgePageMeta,
} from '@/hooks/queries/use-knowledge-queries';

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
  const canUpdate = useCan('knowledge:update');

  const { data: pageData, isLoading, isError } = useKnowledgePage(pageId);
  const { data: treeData } = useKnowledgePageTree();
  const { data: spacesData } = useKnowledgeSpaces();

  const updateMeta = useUpdateKnowledgePageMeta();
  const joinSpace = useJoinKnowledgeSpace();
  const saveContent = useSaveKnowledgePageContent();
  const { mutateAsync: createPage } = useCreateKnowledgePage();

  const page = pageData?.data;
  const allNodes = useMemo(() => treeData?.data ?? [], [treeData]);

  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const titleSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentBlocksRef = useRef<Block[] | null>(null);
  const editorRef = useRef<BlockNoteEditorInstance | null>(null);
  const blockEditorRef = useRef<BlockEditorHandle>(null);
  // Fingerprints of the content this editor recently saved, and the server
  // content last compared against them — see the sync effect below.
  const sentContentRef = useRef<string[]>([]);
  const seenContentRef = useRef<{ pageId: string; contentJson: unknown } | null>(null);

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

  // The editor's "Page" and "Link to page" commands: a new page becomes a
  // child of this one, and links can point at any page in the sidebar tree.
  const pageSpaceId = page?.spaceId;
  const pageLinks = useMemo<PageLinkSource>(
    () => ({
      create: async () => {
        if (!pageSpaceId) return null;
        try {
          const result = await createPage({ spaceId: pageSpaceId, parentId: pageId });
          return { id: result.data.id, title: t.sidebar.untitled, href: `/weldknow/page/${result.data.id}` };
        } catch {
          toast.error(t.page.createError);
          return null;
        }
      },
      search: (query) => {
        const needle = query.trim().toLowerCase();
        return allNodes
          .filter((node) => node.id !== pageId && (node.title || '').toLowerCase().includes(needle))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .slice(0, 10)
          .map((node) => ({
            id: node.id,
            title: node.title || t.sidebar.untitled,
            icon: node.icon,
            href: `/weldknow/page/${node.id}`,
          }));
      },
    }),
    [allNodes, createPage, pageId, pageSpaceId, t],
  );

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
  // (an edit made elsewhere), and never over unsaved edits.
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
  }, [page?.id, page?.contentJson]); // eslint-disable-line react-hooks/exhaustive-deps

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
      {/* Page status — breadcrumbs live in the shared AppHeader */}
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 px-6">
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
            pageLinks={readOnly ? undefined : pageLinks}
            onEditorReady={(editor) => {
              editorRef.current = editor;
            }}
          />
        </div>
      </div>
    </div>
  );
}
