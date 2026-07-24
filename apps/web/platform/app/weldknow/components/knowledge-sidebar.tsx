import { useCallback, useMemo, useState } from 'react';
import { BookOpen, ChevronRight, FileText, MoreHorizontal, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@weldsuite/ui/components/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useRouter, usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  useCreateKnowledgePage,
  useDeleteKnowledgePage,
  useDeleteKnowledgeSpace,
  useKnowledgeFavorites,
  useKnowledgePageTree,
  useKnowledgeSpaces,
  useRemoveKnowledgeFavorite,
  useAddKnowledgeFavorite,
  type KnowledgePageTreeNode,
  type KnowledgeSpace,
} from '@/hooks/queries/use-knowledge-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CreateSpaceDialog } from './create-space-dialog';
import { MovePageDialog } from './move-page-dialog';
import { RenamePageDialog } from './rename-page-dialog';

interface TreeNode extends KnowledgePageTreeNode {
  children: TreeNode[];
}

/** Build a nested tree (children sorted by position) from the flat API response. */
function buildTree(nodes: KnowledgePageTreeNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [] });

  const roots: TreeNode[] = [];
  for (const n of nodes) {
    const node = byId.get(n.id)!;
    if (n.parentId && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => a.position - b.position);
    for (const item of list) sortRec(item.children);
  };
  sortRec(roots);
  return roots;
}

export function KnowledgeSidebar() {
  const t = getTranslations('weldknow');
  const router = useRouter();
  const pathname = usePathname();
  const canCreate = useCan('knowledge:create');
  const canDelete = useCan('knowledge:delete');

  const { data: spacesData, isLoading: spacesLoading } = useKnowledgeSpaces();
  const { data: treeData, isLoading: treeLoading } = useKnowledgePageTree();
  const { data: favoritesData } = useKnowledgeFavorites();

  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [expandedPages, setExpandedPages] = useState<Set<string>>(new Set());
  const [showCreateSpace, setShowCreateSpace] = useState(false);
  const [editingSpace, setEditingSpace] = useState<KnowledgeSpace | null>(null);
  const [movingPageId, setMovingPageId] = useState<string | null>(null);
  const [renamingPage, setRenamingPage] = useState<{ id: string; title: string } | null>(null);
  const [deletingSpace, setDeletingSpace] = useState<KnowledgeSpace | null>(null);
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null);

  const createPage = useCreateKnowledgePage();
  const deletePage = useDeleteKnowledgePage();
  const deleteSpace = useDeleteKnowledgeSpace();
  const addFavorite = useAddKnowledgeFavorite();
  const removeFavorite = useRemoveKnowledgeFavorite();

  const spaces = useMemo(() => spacesData?.data ?? [], [spacesData]);
  const allNodes = useMemo(() => treeData?.data ?? [], [treeData]);
  const favorites = useMemo(() => favoritesData?.data ?? [], [favoritesData]);
  const favoritePageIds = useMemo(() => new Set(favorites.map((f) => f.pageId)), [favorites]);

  const treesBySpace = useMemo(() => {
    const map = new Map<string, TreeNode[]>();
    for (const space of spaces) {
      map.set(space.id, buildTree(allNodes.filter((n) => n.spaceId === space.id)));
    }
    return map;
  }, [spaces, allNodes]);

  const activePageId = useMemo(() => {
    const match = pathname?.match(/\/weldknow\/page\/([^/]+)/);
    return match?.[1] ?? null;
  }, [pathname]);

  const toggleSpace = useCallback((id: string) => {
    setExpandedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePage = useCallback((id: string) => {
    setExpandedPages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCreatePage = useCallback(
    async (spaceId: string, parentId: string | null) => {
      try {
        const result = await createPage.mutateAsync({ spaceId, parentId });
        const newId = result.data.id;
        if (parentId) setExpandedPages((prev) => new Set(prev).add(parentId));
        setExpandedSpaces((prev) => new Set(prev).add(spaceId));
        router.push(`/weldknow/page/${newId}`);
      } catch {
        toast.error(t.page.createError);
      }
    },
    [createPage, router, t],
  );

  const handleToggleFavorite = useCallback(
    async (pageId: string, isFavorite: boolean) => {
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
    },
    [addFavorite, removeFavorite, t],
  );

  const handleDeletePage = useCallback(async () => {
    if (!deletingPageId) return;
    try {
      await deletePage.mutateAsync(deletingPageId);
      toast.success(t.page.deleteSuccess);
      if (activePageId === deletingPageId) router.push('/weldknow');
    } catch {
      toast.error(t.page.deleteError);
    } finally {
      setDeletingPageId(null);
    }
  }, [deletingPageId, deletePage, t, activePageId, router]);

  const handleDeleteSpace = useCallback(async () => {
    if (!deletingSpace) return;
    try {
      await deleteSpace.mutateAsync(deletingSpace.id);
      toast.success(t.space.deleteSuccess);
    } catch {
      toast.error(t.space.deleteError);
    } finally {
      setDeletingSpace(null);
    }
  }, [deletingSpace, deleteSpace, t]);

  const renderPageNode = useCallback(
    (node: TreeNode, space: KnowledgeSpace, depth: number): React.ReactNode => {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedPages.has(node.id);
      const isActive = activePageId === node.id;
      const isFavorite = favoritePageIds.has(node.id);

      return (
        <div key={node.id}>
          <div
            className={cn(
              'group flex items-center gap-1 rounded-md px-1.5 py-1 text-sm cursor-pointer hover:bg-muted/60',
              isActive && 'bg-muted font-medium',
            )}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => router.push(`/weldknow/page/${node.id}`)}
          >
            <button
              type="button"
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground transition-transform',
                isExpanded && 'rotate-90',
                !hasChildren && 'invisible',
              )}
              onClick={(e) => {
                e.stopPropagation();
                togglePage(node.id);
              }}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <span className="shrink-0 text-sm leading-none">
              {node.icon || <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
            </span>
            <span className="flex-1 min-w-0 truncate">{node.title || t.sidebar.untitled}</span>

            <div className="flex items-center opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100">
              {canCreate && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCreatePage(space.id, node.id);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t.sidebar.addPage}</TooltipContent>
                </Tooltip>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="icon" className="h-5 w-5">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuItem onClick={() => handleToggleFavorite(node.id, isFavorite)}>
                    <Star className={cn('mr-2 h-4 w-4', isFavorite && 'fill-yellow-400 text-yellow-400')} />
                    {isFavorite ? t.sidebar.removeFromFavorites : t.sidebar.addToFavorites}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRenamingPage({ id: node.id, title: node.title })}>
                    {t.sidebar.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMovingPageId(node.id)}>
                    {t.sidebar.moveTo}
                  </DropdownMenuItem>
                  {canDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-red-600 focus:text-red-600"
                        onClick={() => setDeletingPageId(node.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t.sidebar.delete}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {hasChildren && isExpanded && (
            <div>{node.children.map((child) => renderPageNode(child, space, depth + 1))}</div>
          )}
        </div>
      );
    },
    [expandedPages, activePageId, favoritePageIds, canCreate, canDelete, togglePage, router, handleCreatePage, handleToggleFavorite, t],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 py-3 border-b">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t.breadcrumb.home}</span>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-2 py-2 space-y-3">
          {/* Favorites */}
          {favorites.length > 0 && (
            <div>
              <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t.sidebar.favorites}
              </div>
              {favorites.map((fav) => (
                <div
                  key={fav.id}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm cursor-pointer hover:bg-muted/60',
                    activePageId === fav.pageId && 'bg-muted font-medium',
                  )}
                  onClick={() => router.push(`/weldknow/page/${fav.pageId}`)}
                >
                  <Star className="h-3.5 w-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
                  <span className="flex-1 min-w-0 truncate">{fav.title || t.sidebar.untitled}</span>
                </div>
              ))}
            </div>
          )}

          {/* Spaces */}
          <div>
            <div className="flex items-center justify-between px-1.5 py-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t.sidebar.spaces}
              </span>
            </div>

            {spacesLoading || treeLoading ? (
              <div className="space-y-2 px-1.5 py-1">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-2/3" />
              </div>
            ) : spaces.length === 0 ? (
              <div className="px-2 py-4 text-center">
                <p className="text-xs text-muted-foreground mb-2">{t.sidebar.noSpacesTitle}</p>
                {canCreate && (
                  <Button size="sm" variant="outline" onClick={() => setShowCreateSpace(true)}>
                    {t.sidebar.createSpace}
                  </Button>
                )}
              </div>
            ) : (
              spaces.map((space) => {
                const isExpanded = expandedSpaces.has(space.id) || expandedSpaces.size === 0;
                const tree = treesBySpace.get(space.id) ?? [];
                return (
                  <Collapsible key={space.id} open={isExpanded} onOpenChange={() => toggleSpace(space.id)}>
                    <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted/60">
                      <CollapsibleTrigger asChild>
                        <button type="button" className="flex flex-1 items-center gap-1.5 min-w-0 text-left">
                          <ChevronRight
                            className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-90')}
                          />
                          <span className="shrink-0">{space.icon || '📁'}</span>
                          <span className="flex-1 min-w-0 truncate text-sm font-medium">{space.name}</span>
                        </button>
                      </CollapsibleTrigger>
                      <div className="flex items-center opacity-0 group-hover:opacity-100">
                        {canCreate && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5"
                                onClick={() => handleCreatePage(space.id, null)}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t.sidebar.newPage}</TooltipContent>
                          </Tooltip>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-5 w-5">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            <DropdownMenuItem onClick={() => setEditingSpace(space)}>
                              {t.sidebar.rename}
                            </DropdownMenuItem>
                            {canDelete && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-red-600 focus:text-red-600"
                                  onClick={() => setDeletingSpace(space)}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  {t.sidebar.delete}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <CollapsibleContent>
                      {tree.length === 0 ? (
                        <div className="px-8 py-1.5 text-xs text-muted-foreground">
                          {t.sidebar.noPagesInSpace}
                        </div>
                      ) : (
                        tree.map((node) => renderPageNode(node, space, 1))
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })
            )}
          </div>
        </div>
      </ScrollArea>

      <div className="border-t p-2 space-y-1">
        {canCreate && (
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setShowCreateSpace(true)}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            {t.sidebar.newSpace}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => router.push('/weldknow/trash')}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {t.sidebar.trash}
        </Button>
      </div>

      <CreateSpaceDialog
        open={showCreateSpace || !!editingSpace}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreateSpace(false);
            setEditingSpace(null);
          }
        }}
        space={editingSpace}
      />

      {movingPageId && (
        <MovePageDialog
          pageId={movingPageId}
          open={!!movingPageId}
          onOpenChange={(open) => !open && setMovingPageId(null)}
        />
      )}

      {renamingPage && (
        <RenamePageDialog
          pageId={renamingPage.id}
          initialTitle={renamingPage.title}
          open={!!renamingPage}
          onOpenChange={(open) => !open && setRenamingPage(null)}
        />
      )}

      <ConfirmDialog
        open={!!deletingPageId}
        onOpenChange={(open) => !open && setDeletingPageId(null)}
        title={t.page.deleteTitle}
        description={t.page.deleteDescription}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={deletePage.isPending}
        onConfirm={handleDeletePage}
      />

      <ConfirmDialog
        open={!!deletingSpace}
        onOpenChange={(open) => !open && setDeletingSpace(null)}
        title={t.space.deleteTitle}
        description={t.space.deleteDescription}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={deleteSpace.isPending}
        onConfirm={handleDeleteSpace}
      />
    </div>
  );
}
