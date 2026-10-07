import * as React from 'react';
import { BookOpen, FileText, LayoutGrid, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useCan } from '@weldsuite/permissions/react';
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { usePathname, useRouter } from '@/lib/router';
import {
  useAddKnowledgeFavorite,
  useCreateKnowledgePage,
  useDeleteKnowledgePage,
  useDeleteKnowledgeSpace,
  useKnowledgeFavorites,
  useKnowledgePageTree,
  useKnowledgeSpaces,
  useLeaveKnowledgeSpace,
  useRemoveKnowledgeFavorite,
  type KnowledgeSpace,
} from '@/hooks/queries/use-knowledge-queries';
import { CreateSpaceDialog } from '../components/create-space-dialog';
import { MovePageDialog } from '../components/move-page-dialog';
import { RenamePageDialog } from '../components/rename-page-dialog';
import { SpaceMembersDialog } from '../components/space-members-dialog';
import {
  KnowledgeSpaceTree,
  buildKnowledgeTree,
  type KnowledgeTreeNode,
} from '../components/knowledge-space-tree';

function toggleInSet(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Sidebar icon slot for a page's emoji, falling back to the generic page icon. */
function pageIcon(emoji: string | null | undefined): MenuItemProps['icon'] {
  if (!emoji) return FileText;
  const EmojiIcon = ({ className }: { className?: string }) => (
    <span className={`${className ?? ''} flex items-center justify-center text-sm leading-none`}>{emoji}</span>
  );
  return EmojiIcon;
}

/**
 * WeldKnow entries for the shared module sidebar: General (Home, Teamspaces,
 * Trash), Favorites, Private (the caller's personal space) and Teamspaces (the
 * ones they joined). Page trees are rendered as custom content so they can
 * nest arbitrarily deep.
 */
export function useWeldknowSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
  dialogs: React.ReactNode;
} {
  const { t: tAll } = useI18n();
  const t = getTranslations('weldknow');
  const router = useRouter();
  const pathname = usePathname();
  const canCreate = useCan('knowledge:create');
  const canDelete = useCan('knowledge:delete');
  const canRead = useCan('knowledge:read');
  const enabled = isActive && canRead;

  const { data: spacesData, isLoading: spacesLoading } = useKnowledgeSpaces(enabled);
  const { data: treeData, isLoading: treeLoading } = useKnowledgePageTree(undefined, enabled);
  const { data: favoritesData } = useKnowledgeFavorites(enabled);

  // Spaces are expanded by default; we track the ones the user collapsed.
  const [collapsedSpaces, setCollapsedSpaces] = React.useState<Set<string>>(new Set());
  const [expandedPages, setExpandedPages] = React.useState<Set<string>>(new Set());
  const [showCreateSpace, setShowCreateSpace] = React.useState(false);
  const [editingSpace, setEditingSpace] = React.useState<KnowledgeSpace | null>(null);
  const [movingPageId, setMovingPageId] = React.useState<string | null>(null);
  const [renamingPage, setRenamingPage] = React.useState<{ id: string; title: string } | null>(null);
  const [deletingSpace, setDeletingSpace] = React.useState<KnowledgeSpace | null>(null);
  const [membersSpaceId, setMembersSpaceId] = React.useState<string | null>(null);
  const [leavingSpace, setLeavingSpace] = React.useState<KnowledgeSpace | null>(null);
  const [deletingPageId, setDeletingPageId] = React.useState<string | null>(null);

  const createPage = useCreateKnowledgePage();
  const deletePage = useDeleteKnowledgePage();
  const deleteSpace = useDeleteKnowledgeSpace();
  const leaveSpace = useLeaveKnowledgeSpace();
  const addFavorite = useAddKnowledgeFavorite();
  const removeFavorite = useRemoveKnowledgeFavorite();

  const allSpaces = React.useMemo(() => spacesData?.data ?? [], [spacesData]);
  const personalSpaces = React.useMemo(() => allSpaces.filter((s) => s.kind === 'personal'), [allSpaces]);
  // The sidebar lists joined teamspaces only; the rest live on the Teamspaces page.
  const spaces = React.useMemo(() => allSpaces.filter((s) => s.kind === 'team' && s.isMember), [allSpaces]);
  const allNodes = React.useMemo(() => treeData?.data ?? [], [treeData]);
  const favorites = React.useMemo(() => favoritesData?.data ?? [], [favoritesData]);
  const favoritePageIds = React.useMemo(() => new Set(favorites.map((f) => f.pageId)), [favorites]);

  const treesBySpace = React.useMemo(() => {
    const map = new Map<string, KnowledgeTreeNode[]>();
    for (const space of allSpaces) {
      map.set(space.id, buildKnowledgeTree(allNodes.filter((n) => n.spaceId === space.id)));
    }
    return map;
  }, [allSpaces, allNodes]);

  const activePageId = React.useMemo(() => {
    const match = pathname?.match(/\/weldknow\/page\/([^/]+)/);
    return match?.[1] ?? null;
  }, [pathname]);

  // Reveal the active page: expand its space and every ancestor page.
  React.useEffect(() => {
    if (!activePageId || allNodes.length === 0) return;
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const active = byId.get(activePageId);
    if (!active) return;
    const ancestors: string[] = [];
    let parentId = active.parentId;
    while (parentId && byId.has(parentId) && !ancestors.includes(parentId)) {
      ancestors.push(parentId);
      parentId = byId.get(parentId)!.parentId;
    }
    if (ancestors.length > 0) {
      setExpandedPages((prev) => (ancestors.every((id) => prev.has(id)) ? prev : new Set([...prev, ...ancestors])));
    }
    setCollapsedSpaces((prev) => {
      if (!prev.has(active.spaceId)) return prev;
      const next = new Set(prev);
      next.delete(active.spaceId);
      return next;
    });
  }, [activePageId, allNodes]);

  const expandedSpaces = React.useMemo(
    () => new Set(spaces.filter((s) => !collapsedSpaces.has(s.id)).map((s) => s.id)),
    [spaces, collapsedSpaces],
  );

  const handleCreatePage = React.useCallback(
    async (spaceId: string, parentId: string | null) => {
      try {
        const result = await createPage.mutateAsync({ spaceId, parentId });
        if (parentId) setExpandedPages((prev) => new Set(prev).add(parentId));
        setCollapsedSpaces((prev) => {
          const next = new Set(prev);
          next.delete(spaceId);
          return next;
        });
        router.push(`/weldknow/page/${result.data.id}`);
      } catch {
        toast.error(t.page.createError);
      }
    },
    [createPage, router, t],
  );

  const handleToggleFavorite = React.useCallback(
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

  const handleDeletePage = React.useCallback(async () => {
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

  const handleDeleteSpace = React.useCallback(async () => {
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

  const handleLeaveSpace = React.useCallback(async () => {
    if (!leavingSpace) return;
    try {
      await leaveSpace.mutateAsync(leavingSpace.id);
      toast.success(t.teamspaces.leaveSuccess);
    } catch (err) {
      toast.error(isApiError(err) && err.status === 409 ? t.members.lastOwner : t.teamspaces.leaveError);
    } finally {
      setLeavingSpace(null);
    }
  }, [leavingSpace, leaveSpace, t]);

  const toggleSpace = React.useCallback((id: string) => setCollapsedSpaces((prev) => toggleInSet(prev, id)), []);
  const togglePage = React.useCallback((id: string) => setExpandedPages((prev) => toggleInSet(prev, id)), []);
  const openCreateSpace = React.useCallback(() => setShowCreateSpace(true), []);

  const menuGroups = React.useMemo<MenuGroupProps[]>(() => {
    if (!isActive) return [];

    const groups: MenuGroupProps[] = [
      {
        group: tAll.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.sidebar.home, href: '/weldknow', icon: BookOpen, isActive: pathname === '/weldknow' },
          { title: t.sidebar.allTeamspaces, href: '/weldknow/teamspaces', icon: LayoutGrid },
          { title: t.sidebar.trash, href: '/weldknow/trash', icon: Trash2 },
        ],
      },
    ];

    if (favorites.length > 0) {
      groups.push({
        group: t.sidebar.favorites,
        items: favorites.map((fav) => ({
          title: fav.title || t.sidebar.untitled,
          href: `/weldknow/page/${fav.pageId}`,
          icon: pageIcon(fav.icon),
          // Favorites duplicate tree rows; only the tree row shows as active.
          isActive: false,
        })),
      });
    }

    const treeProps = {
      treesBySpace,
      isLoading: spacesLoading || treeLoading,
      activePageId,
      favoritePageIds,
      expandedSpaces,
      expandedPages,
      canCreate,
      canDelete,
      onToggleSpace: toggleSpace,
      onTogglePage: togglePage,
      onCreateSpace: openCreateSpace,
      onCreatePage: handleCreatePage,
      onEditSpace: setEditingSpace,
      onShowMembers: (space: KnowledgeSpace) => setMembersSpaceId(space.id),
      onLeaveSpace: setLeavingSpace,
      onDeleteSpace: setDeletingSpace,
      onToggleFavorite: handleToggleFavorite,
      onRenamePage: setRenamingPage,
      onMovePage: setMovingPageId,
      onDeletePage: setDeletingPageId,
    };

    const personal = personalSpaces[0];
    if (personal) {
      groups.push({
        group: t.sidebar.private,
        items: [],
        onAdd: canCreate ? () => void handleCreatePage(personal.id, null) : undefined,
        customContent: (
          <KnowledgeSpaceTree {...treeProps} spaces={[personal]} flat emptyLabel={t.sidebar.noPrivatePages} />
        ),
      });
    }

    groups.push({
      group: t.sidebar.teamspaces,
      items: [],
      onAdd: canCreate && spaces.length > 0 ? openCreateSpace : undefined,
      customContent: <KnowledgeSpaceTree {...treeProps} spaces={spaces} />,
    });

    return groups;
  }, [
    isActive, tAll, t, pathname, favorites, canCreate, canDelete, spaces, personalSpaces, treesBySpace, spacesLoading,
    treeLoading, activePageId, favoritePageIds, expandedSpaces, expandedPages, toggleSpace, togglePage,
    openCreateSpace, handleCreatePage, handleToggleFavorite,
  ]);

  const dialogs = (
    <>
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

      <SpaceMembersDialog
        space={allSpaces.find((s) => s.id === membersSpaceId) ?? null}
        onOpenChange={(open) => !open && setMembersSpaceId(null)}
      />

      <ConfirmDialog
        open={!!leavingSpace}
        onOpenChange={(open) => !open && setLeavingSpace(null)}
        title={t.teamspaces.leaveTitle}
        description={t.teamspaces.leaveDescription}
        confirmLabel={t.sidebar.leave}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={leaveSpace.isPending}
        onConfirm={handleLeaveSpace}
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
    </>
  );

  return { menuGroups, dialogs };
}
