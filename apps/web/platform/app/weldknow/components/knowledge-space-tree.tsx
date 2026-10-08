import { ChevronRight, FileText, MoreVertical, Plus, Star, SquarePen, Move, Trash2, Folder, Settings, Users, LogOut, Lock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@weldsuite/ui/components/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import type { KnowledgePageTreeNode, KnowledgeSpace } from '@/hooks/queries/use-knowledge-queries';

export interface KnowledgeTreeNode extends KnowledgePageTreeNode {
  children: KnowledgeTreeNode[];
}

/** Build a nested tree (children sorted by position) from the flat API response. */
export function buildKnowledgeTree(nodes: KnowledgePageTreeNode[]): KnowledgeTreeNode[] {
  const byId = new Map<string, KnowledgeTreeNode>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [] });

  const roots: KnowledgeTreeNode[] = [];
  for (const n of nodes) {
    const node = byId.get(n.id)!;
    if (n.parentId && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (list: KnowledgeTreeNode[]) => {
    list.sort((a, b) => a.position - b.position);
    for (const item of list) sortRec(item.children);
  };
  sortRec(roots);
  return roots;
}

/** Emoji (or fallback lucide icon) sized to sit in the sidebar's 16px icon slot. */
function NodeIcon({ emoji, fallback: Fallback }: Readonly<{ emoji: string | null | undefined; fallback: typeof FileText }>) {
  if (emoji) {
    return <span className="flex h-4 w-4 shrink-0 items-center justify-center text-sm leading-none">{emoji}</span>;
  }
  return <Fallback className="h-4 w-4 shrink-0" />;
}

const ROW_ACTION_CLASS =
  'h-6 w-6 rounded-md hover:bg-black/[0.05] dark:hover:bg-black/20 data-[state=open]:bg-black/[0.05] dark:data-[state=open]:bg-black/20';

/** Indent per tree level, on top of the sidebar button's own 8px padding. */
const INDENT_PX = 12;

export interface KnowledgeSpaceTreeProps {
  spaces: KnowledgeSpace[];
  treesBySpace: Map<string, KnowledgeTreeNode[]>;
  isLoading: boolean;
  activePageId: string | null;
  favoritePageIds: Set<string>;
  expandedSpaces: Set<string>;
  expandedPages: Set<string>;
  /** Workspace permissions; each space's own `canWrite`/`canManage` narrows them further. */
  canCreate: boolean;
  canDelete: boolean;
  /**
   * Render the pages of the single given space without its header row — the
   * personal "Private" section, which is its own sidebar group.
   */
  flat?: boolean;
  onToggleSpace: (id: string) => void;
  onTogglePage: (id: string) => void;
  onCreateSpace: () => void;
  onCreatePage: (spaceId: string, parentId: string | null) => void;
  onEditSpace: (space: KnowledgeSpace) => void;
  onShowMembers: (space: KnowledgeSpace) => void;
  onLeaveSpace: (space: KnowledgeSpace) => void;
  onDeleteSpace: (space: KnowledgeSpace) => void;
  onToggleFavorite: (pageId: string, isFavorite: boolean) => void;
  onRenamePage: (page: { id: string; title: string }) => void;
  onMovePage: (pageId: string) => void;
  onDeletePage: (pageId: string) => void;
}

/**
 * The WeldKnow spaces → pages tree, rendered as `customContent` of the
 * "Private" and "Teamspaces" groups inside the shared module sidebar. Rows
 * reuse the sidebar's `SidebarMenuButton` so they match every other app's nav
 * items. Write actions only show where the caller's teamspace role allows them.
 */
export function KnowledgeSpaceTree(props: Readonly<KnowledgeSpaceTreeProps>) {
  const t = getTranslations('weldknow');
  const {
    spaces,
    treesBySpace,
    isLoading,
    activePageId,
    favoritePageIds,
    expandedSpaces,
    expandedPages,
    canCreate,
    canDelete,
    flat = false,
    onToggleSpace,
    onTogglePage,
    onCreateSpace,
    onCreatePage,
    onEditSpace,
    onShowMembers,
    onLeaveSpace,
    onDeleteSpace,
    onToggleFavorite,
    onRenamePage,
    onMovePage,
    onDeletePage,
  } = props;

  if (isLoading) {
    return (
      <div className="space-y-2 px-2 py-1">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-2/3" />
      </div>
    );
  }

  if (spaces.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          {canCreate ? (
            <Button
              variant="ghost"
              onClick={onCreateSpace}
              className="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground border border-dashed border-gray-300 dark:border-border hover:border-gray-400 dark:hover:border-gray-500 rounded-md transition-colors h-auto"
            >
              <Plus className="h-4 w-4" />
              <span>{t.sidebar.createSpace}</span>
            </Button>
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t.sidebar.noSpacesTitle}</p>
          )}
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const renderPage = (node: KnowledgeTreeNode, space: KnowledgeSpace, depth: number): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedPages.has(node.id);
    const isActive = activePageId === node.id;
    const isFavorite = favoritePageIds.has(node.id);
    const canWrite = space.canWrite;

    return (
      <SidebarMenuItem key={node.id}>
        <div className="group/item relative flex items-center rounded-md transition-colors hover:bg-accent">
          <SidebarMenuButton
            asChild
            isActive={isActive}
            className="flex-1 hover:bg-transparent group-hover/item:pr-14 group-has-[[data-state=open]]/item:pr-14"
            style={{ paddingLeft: 8 + depth * INDENT_PX }}
          >
            <Link href={`/weldknow/page/${node.id}`}>
              <span
                role="button"
                tabIndex={-1}
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-black/[0.06] dark:hover:bg-white/10',
                  !hasChildren && 'invisible',
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onTogglePage(node.id);
                }}
              >
                <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
              </span>
              <NodeIcon emoji={node.icon} fallback={FileText} />
              <span className="truncate min-w-0 text-muted-foreground">{node.title || t.sidebar.untitled}</span>
            </Link>
          </SidebarMenuButton>

          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/item:opacity-100 group-has-[[data-state=open]]/item:opacity-100">
            {canCreate && canWrite && (
              <Button
                variant="ghost"
                size="icon"
                className={ROW_ACTION_CLASS}
                aria-label={t.sidebar.addPage}
                onClick={() => onCreatePage(space.id, node.id)}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className={ROW_ACTION_CLASS}>
                  <MoreVertical className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onToggleFavorite(node.id, isFavorite)} className="gap-2">
                  <Star className={cn('h-4 w-4', isFavorite && 'fill-yellow-400 text-yellow-400')} />
                  {isFavorite ? t.sidebar.removeFromFavorites : t.sidebar.addToFavorites}
                </DropdownMenuItem>
                {canWrite && (
                  <>
                    <DropdownMenuItem onClick={() => onRenamePage({ id: node.id, title: node.title })} className="gap-2">
                      <SquarePen className="h-4 w-4" />
                      {t.sidebar.rename}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onMovePage(node.id)} className="gap-2">
                      <Move className="h-4 w-4" />
                      {t.sidebar.moveTo}
                    </DropdownMenuItem>
                  </>
                )}
                {canDelete && canWrite && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => onDeletePage(node.id)} className="gap-2">
                      <Trash2 className="h-4 w-4" />
                      {t.sidebar.delete}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {hasChildren && isExpanded && (
          <SidebarMenu>{node.children.map((child) => renderPage(child, space, depth + 1))}</SidebarMenu>
        )}
      </SidebarMenuItem>
    );
  };

  if (flat) {
    const space = spaces[0]!;
    const tree = treesBySpace.get(space.id) ?? [];
    // An empty flat section shows just its heading (and "add" button).
    if (tree.length === 0) return null;
    return <SidebarMenu>{tree.map((node) => renderPage(node, space, 0))}</SidebarMenu>;
  }

  return (
    <SidebarMenu>
      {spaces.map((space) => {
        const isExpanded = expandedSpaces.has(space.id);
        const tree = treesBySpace.get(space.id) ?? [];
        const canAddPage = canCreate && space.canWrite;
        return (
          <SidebarMenuItem key={space.id}>
            <div className="group/item relative flex items-center rounded-md transition-colors hover:bg-accent">
              <SidebarMenuButton
                className="flex-1 hover:bg-transparent group-hover/item:pr-14 group-has-[[data-state=open]]/item:pr-14"
                onClick={() => onToggleSpace(space.id)}
                aria-expanded={isExpanded}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                  <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
                </span>
                <NodeIcon emoji={space.icon} fallback={Folder} />
                <span className="truncate min-w-0 text-foreground">{space.name}</span>
                {space.visibility !== 'open' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
              </SidebarMenuButton>

              <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/item:opacity-100 group-has-[[data-state=open]]/item:opacity-100">
                {canAddPage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={ROW_ACTION_CLASS}
                    aria-label={t.sidebar.newPage}
                    onClick={() => onCreatePage(space.id, null)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className={ROW_ACTION_CLASS}>
                      <MoreVertical className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canAddPage && (
                      <DropdownMenuItem onClick={() => onCreatePage(space.id, null)} className="gap-2">
                        <Plus className="h-4 w-4" />
                        {t.sidebar.newPage}
                      </DropdownMenuItem>
                    )}
                    {space.canManage && (
                      <DropdownMenuItem onClick={() => onEditSpace(space)} className="gap-2">
                        <Settings className="h-4 w-4" />
                        {t.sidebar.settings}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => onShowMembers(space)} className="gap-2">
                      <Users className="h-4 w-4" />
                      {t.sidebar.members}
                    </DropdownMenuItem>
                    {space.isMember && (
                      <DropdownMenuItem onClick={() => onLeaveSpace(space)} className="gap-2">
                        <LogOut className="h-4 w-4" />
                        {t.sidebar.leave}
                      </DropdownMenuItem>
                    )}
                    {canDelete && space.canManage && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => onDeleteSpace(space)} className="gap-2">
                          <Trash2 className="h-4 w-4" />
                          {t.sidebar.delete}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {isExpanded && (
              tree.length === 0 ? (
                <p className="py-1.5 pr-2 text-xs text-muted-foreground" style={{ paddingLeft: 8 + INDENT_PX + 24 }}>
                  {t.sidebar.noPagesInSpace}
                </p>
              ) : (
                <SidebarMenu>{tree.map((node) => renderPage(node, space, 1))}</SidebarMenu>
              )
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
