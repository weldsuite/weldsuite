
import { useState, useMemo, useCallback, useEffect } from "react";
import { useRouter, Link } from '@/lib/router';
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@weldsuite/ui/components/dialog";
import { SoftBadge, type SoftTone } from "@weldsuite/ui/components/soft-badge";
import { ConfirmDialog } from "@weldsuite/ui/components/confirm-dialog";
import {
  EllipsisVertical,
  Edit,
  Eye,
  Trash2,
  FileText,
  FolderOpen,
  Folder,
  ChevronRight,
  ChevronDown,
  FolderPlus,
} from "lucide-react";
import { useCreateKnowledgeFolder, useCreateArticle, useHelpdeskFolders, useDeleteArticle, useDeleteFolder, useUpdateFolder } from "@/hooks/queries/use-helpdesk-queries";
import type { KnowledgeArticle as Article } from "@/hooks/queries/use-helpdesk-queries";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@weldsuite/ui/components/select";
import { Label } from "@weldsuite/ui/components/label";
import { RowOverlayButton } from "@/components/shared/row-overlay-button";
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from "@/components/entity-list";
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface KnowledgeClientProps {
  items: Article[];
  isLoading?: boolean;
}

// Status: label fallback and the standard soft badge tone.
const statusConfig: Record<string, { label: string; tone: SoftTone }> = {
  published: { label: 'Published', tone: 'success' },
  draft: { label: 'Draft', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
  review: { label: 'Review', tone: 'warning' },
  outdated: { label: 'Outdated', tone: 'warning' },
};

// ── Tree node types ─────────────────────────────────────────────────────────

interface FolderData {
  id: string;
  name: string;
  parentId: string | null;
  level: number;
  articleCount: number;
  icon?: string;
  color?: string;
}

interface RawFolder {
  id: string;
  name: string;
  parentId?: string | null;
  level?: number;
  articleCount?: number;
  icon?: string | null;
  color?: string | null;
}

interface TreeNode {
  id: string;
  type: 'folder' | 'article';
  title: string; // searchable: folder name or article title
  folder?: FolderData;
  article?: Article;
  depth: number;
  children: TreeNode[];
}

function buildTree(folders: FolderData[], articles: Article[]): TreeNode[] {
  // Build folder map
  const folderMap = new Map<string, TreeNode>();
  for (const f of folders) {
    folderMap.set(f.id, {
      id: f.id,
      type: 'folder',
      title: f.name,
      folder: f,
      depth: f.level,
      children: [],
    });
  }

  // Nest sub-folders under parents
  const rootNodes: TreeNode[] = [];
  for (const f of folders) {
    const node = folderMap.get(f.id)!;
    if (f.parentId && folderMap.has(f.parentId)) {
      folderMap.get(f.parentId)!.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  // Place articles under their folder or at root
  const rootArticles: TreeNode[] = [];
  for (const a of articles) {
    const articleNode: TreeNode = {
      id: a.id,
      type: 'article',
      title: a.title,
      article: a,
      depth: 0,
      children: [],
    };
    if (a.categoryId && folderMap.has(a.categoryId)) {
      const parent = folderMap.get(a.categoryId)!;
      articleNode.depth = parent.depth + 1;
      parent.children.push(articleNode);
    } else {
      rootArticles.push(articleNode);
    }
  }

  // Folders first, then loose articles
  return [...rootNodes, ...rootArticles];
}

interface FlatNode extends TreeNode {
  depth: number;
  isLast: boolean; // last sibling at this depth
  parentIsLast: boolean[]; // for each ancestor depth, whether that ancestor was the last sibling
}

function flattenTree(
  nodes: TreeNode[],
  expandedIds: Set<string>,
  depth = 0,
  parentIsLast: boolean[] = [],
): FlatNode[] {
  const result: FlatNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    result.push({ ...node, depth, isLast, parentIsLast: [...parentIsLast] });
    if (node.type === 'folder' && expandedIds.has(node.id) && node.children.length > 0) {
      result.push(...flattenTree(node.children, expandedIds, depth + 1, [...parentIsLast, isLast]));
    }
  }
  return result;
}

// This view renders a client-built folder/article tree via EntityList rather
// than a server-paginated/filtered list.
export function KnowledgeClient({
  items,
  isLoading = false,
}: Readonly<KnowledgeClientProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const router = useRouter();
  const [data, setData] = useState<Article[]>(items);
  const createFolderMutation = useCreateKnowledgeFolder();
  const createArticleMutation = useCreateArticle();
  const deleteArticleMutation = useDeleteArticle();
  const deleteFolderMutation = useDeleteFolder();
  const updateFolderMutation = useUpdateFolder();
  const { data: foldersResult, refetch: refetchFolders } = useHelpdeskFolders();

  // Folder state
  const folders: FolderData[] = useMemo(() => {
    const raw = foldersResult?.data || [];
    return raw.map((f: RawFolder) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId || null,
      level: f.level || 0,
      articleCount: f.articleCount || 0,
      icon: f.icon ?? undefined,
      color: f.color ?? undefined,
    }));
  }, [foldersResult]);

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [showCreateFolderDialog, setShowCreateFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);

  // Folder rename dialog
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");

  // Create article dialog state
  const [showCreateArticleDialog, setShowCreateArticleDialog] = useState(false);
  const [newArticleTitle, setNewArticleTitle] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // Delete confirmation (article or folder)
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'article' | 'folder'; id: string } | null>(null);

  // Update state when props change
  useEffect(() => {
    setData(items);
  }, [items]);

  // Build tree
  const tree = useMemo(() => buildTree(folders, data), [folders, data]);

  // Flatten visible nodes
  const visibleNodes = useMemo(() => {
    return flattenTree(tree, expandedFolders);
  }, [tree, expandedFolders]);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  // Get unique categories for filter
  const uniqueCategories = useMemo(() =>
    Array.from(new Set(data.map(a => a.category).filter(Boolean))),
    [data]
  );

  // Folder creation handlers
  const openCreateFolderDialog = (parentId: string | null = null) => {
    setSelectedParentId(parentId);
    setNewFolderName("");
    setShowCreateFolderDialog(true);
  };

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;

    setIsCreatingFolder(true);
    createFolderMutation.mutate(
      {
        name: newFolderName.trim(),
        parentId: selectedParentId || undefined,
      },
      {
        onSuccess: async (result) => {
          if (result.data?.id) {
            toast.success(t.helpdesk.knowledge.createdFolderSuccess.replace('{name}', newFolderName));
            // Auto-expand parent so the new subfolder is visible
            if (selectedParentId) {
              setExpandedFolders((prev) => new Set([...prev, selectedParentId]));
            }
            setShowCreateFolderDialog(false);
            setNewFolderName("");
            setSelectedParentId(null);
            // Explicitly refetch folders to ensure the tree updates
            await refetchFolders();
          } else {
            toast.error(t.helpdesk.knowledge.failedToCreateFolder);
          }
        },
        onError: () => {
          toast.error(t.helpdesk.knowledge.failedToCreateFolder);
        },
        onSettled: () => {
          setIsCreatingFolder(false);
        },
      }
    );
  };

  // The row menus only ask; the ConfirmDialog below runs the delete.
  const handleDeleteArticle = (id: string) => setPendingDelete({ kind: 'article', id });
  const handleDeleteFolder = (id: string) => setPendingDelete({ kind: 'folder', id });

  const deleteArticle = (id: string) => {
    deleteArticleMutation.mutate(id, {
      onSuccess: () => {
        toast.success(t.helpdesk.knowledgeEditor.articleDeleted);
        setData((prev) => prev.filter((a) => a.id !== id));
        setPendingDelete(null);
      },
      onError: () => toast.error(t.helpdesk.knowledgeEditor.failedToDeleteArticle),
    });
  };

  const deleteFolder = (id: string) => {
    deleteFolderMutation.mutate(id, {
      onSuccess: async () => {
        toast.success(t.helpdesk.knowledge.folderDeleted);
        setPendingDelete(null);
        await refetchFolders();
      },
      onError: () => toast.error(t.helpdesk.knowledge.failedToDeleteFolder),
    });
  };

  const handleRenameFolder = () => {
    if (!renameFolderId || !renameFolderName.trim()) return;
    updateFolderMutation.mutate(
      { id: renameFolderId, data: { name: renameFolderName.trim() } },
      {
        onSuccess: async () => {
          toast.success(t.helpdesk.knowledge.folderRenamed);
          setRenameFolderId(null);
          setRenameFolderName("");
          await refetchFolders();
        },
        onError: () => toast.error(t.helpdesk.knowledge.failedToRenameFolder),
      },
    );
  };

  const openCreateArticleDialog = () => {
    setNewArticleTitle("");
    setSelectedFolderId(null);
    setShowCreateArticleDialog(true);
  };

  const handleCreateArticle = () => {
    if (!newArticleTitle.trim()) return;

    createArticleMutation.mutate(
      {
        title: newArticleTitle.trim(),
        content: "",
        folderId: selectedFolderId || undefined,
        status: "draft",
      },
      {
        onSuccess: (result) => {
          if (result.data?.id) {
            toast.success(t.helpdesk.knowledge.createdArticleSuccess.replace('{name}', newArticleTitle));
            setShowCreateArticleDialog(false);
            router.push(`/welddesk/help-center/articles/${result.data.id}/edit`);
          } else {
            toast.error(t.helpdesk.knowledge.failedToCreateArticle);
          }
        },
        onError: () => {
          toast.error(t.helpdesk.knowledge.failedToCreateArticle);
        },
      }
    );
  };

  // Count children (articles + sub-folders) for a folder
  const getFolderChildCount = useCallback((folderId: string): number => {
    const directArticles = data.filter(a => a.categoryId === folderId).length;
    const subFolders = folders.filter(f => f.parentId === folderId).length;
    return directArticles + subFolders;
  }, [data, folders]);

  // ── Render ──────────────────────────────────────────────────────────────

  // Header columns
  const kn = t.helpdesk.knowledge;
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'title', header: kn.titleLabel, width: 'flex-1 min-w-[250px]' },
    { id: 'visibility', header: kn.colVisibility, width: 'w-[100px]' },
    { id: 'category', header: kn.category, width: 'w-[150px]' },
    { id: 'views', header: kn.views, width: 'w-[80px]' },
    { id: 'helpful', header: kn.helpful, width: 'w-[80px]' },
    { id: 'lastUpdated', header: kn.colUpdated, width: 'w-[120px]' },
    { id: 'status', header: kn.colStatus, width: 'w-[100px]' },
  ], [kn]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: kn.colStatus,
      options: [
        { value: 'published', label: kn.filterPublished },
        { value: 'draft', label: kn.filterDraft },
        { value: 'archived', label: kn.filterArchived },
      ],
    },
    {
      field: 'visibility',
      label: kn.colVisibility,
      options: [
        { value: 'public', label: kn.filterPublic },
        { value: 'logged_in', label: t.helpdesk.knowledgeInbox.visibility.logged_in },
        { value: 'groups', label: t.helpdesk.knowledgeInbox.visibility.groups },
        { value: 'internal', label: kn.filterInternal },
      ],
    },
    ...(uniqueCategories.length > 0 ? [{
      field: 'category',
      label: kn.category,
      options: uniqueCategories.map(c => ({ value: c, label: c })),
    }] : []),
  ], [uniqueCategories, kn, t.helpdesk.knowledgeInbox]);

  // Group configs by status
  const groupConfigs: GroupConfig<FlatNode>[] = useMemo(() => [], []);

  // Apply filters
  const applyFilters = useCallback((items: FlatNode[], filters: ActiveFilter[]) => {
    if (filters.length === 0) return items;

    return items.filter(node => {
      // Folders always pass filters (they contain articles)
      if (node.type === 'folder') return true;

      const article = node.article!;
      return filters.every(filter => {
        if (!filter.operator || !filter.value) return true;
        if (filter.field === 'status') {
          return filter.operator === 'is'
            ? article.status === filter.value
            : article.status !== filter.value;
        }
        if (filter.field === 'visibility') {
          return filter.operator === 'is'
            ? article.visibility === filter.value
            : article.visibility !== filter.value;
        }
        if (filter.field === 'category') {
          return filter.operator === 'is'
            ? article.category === filter.value
            : article.category !== filter.value;
        }
        return true;
      });
    });
  }, []);

  // The standard list row (the WeldFlow task row): one line, the divider and
  // hover of every list, a whole-row click target and the ⋮ menu in the gutter.
  const ROW_CLASS =
    'group relative flex cursor-pointer items-center gap-4 border-b border-gray-200/70 px-4 py-3 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50';
  // A folder's contents sit one step further in.
  const indent = (depth: number) => (depth > 0 ? { paddingLeft: `${16 + depth * 24}px` } : undefined);

  const rowMenu = (label: string, items: React.ReactNode) => (
    // h-7 holds the task row's 53px height.
    <div className="relative z-[1] flex h-7 w-[40px] items-center justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${t.common.actions.openMenu}: ${label}`}
            className="h-7 w-7 p-0 text-gray-400 opacity-0 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{items}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const deleteItem = (onSelect: () => void) => (
    <DropdownMenuItem onSelect={onSelect} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
      <Trash2 className="mr-0.5 h-4 w-4 text-destructive" />
      {t.helpdesk.actions.delete}
    </DropdownMenuItem>
  );

  const renderFolderRow = (node: FlatNode) => {
    const folder = node.folder!;
    const isExpanded = expandedFolders.has(folder.id);
    const childCount = getFolderChildCount(folder.id);
    const FolderIcon = isExpanded ? FolderOpen : Folder;
    const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;
    const countLabel = `${childCount} ${childCount === 1 ? kn.itemSingular : kn.itemPlural}`;

    return (
      <div key={folder.id} className={ROW_CLASS} style={indent(node.depth)}>
        <RowOverlayButton label={folder.name} expanded={isExpanded} onClick={() => toggleFolder(folder.id)} />
        <div className="flex min-w-[250px] flex-1 items-center gap-2">
          <ChevronIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <FolderIcon className="h-4 w-4 flex-shrink-0 text-blue-500" />
          <span className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{folder.name}</span>
          {/* The count chip of the list's group headers. */}
          <span
            className="flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-[5px] border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground"
            title={countLabel}
            aria-label={countLabel}
          >
            {childCount}
          </span>
        </div>

        {/* The article columns stay empty on a folder. */}
        <div className="w-[100px]" />
        <div className="w-[150px]" />
        <div className="w-[80px]" />
        <div className="w-[80px]" />
        <div className="w-[120px]" />
        <div className="w-[100px]" />

        {rowMenu(
          folder.name,
          <>
            <DropdownMenuItem onSelect={() => openCreateFolderDialog(folder.id)}>
              <FolderPlus className="mr-0.5 h-4 w-4" />
              {kn.newSubfolder}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setRenameFolderId(folder.id);
                setRenameFolderName(folder.name);
              }}
            >
              <Edit className="mr-0.5 h-4 w-4" />
              {kn.renameFolder}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {deleteItem(() => handleDeleteFolder(folder.id))}
          </>,
        )}
      </div>
    );
  };

  const renderArticleRow = (node: FlatNode) => {
    const article = node.article!;
    const status = statusConfig[article.status] || statusConfig.draft;

    return (
      <div key={article.id} className={ROW_CLASS} style={indent(node.depth)}>
        <RowOverlayButton label={article.title} onClick={() => router.push(`/welddesk/help-center/articles/${article.id}`)} />
        <div className="flex min-w-[250px] flex-1 items-center gap-2">
          <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{article.title}</span>
        </div>

        <div className="w-[100px]">
          <span className="block truncate text-sm text-gray-600 dark:text-muted-foreground">
            {t.helpdesk.knowledgeInbox.visibility[article.visibility as keyof typeof t.helpdesk.knowledgeInbox.visibility] ?? article.visibility}
          </span>
        </div>
        <div className="w-[150px]">
          {article.category ? (
            <span className="block truncate text-sm text-gray-600 dark:text-muted-foreground">{article.category}</span>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </div>
        <div className="w-[80px]">
          <span className="text-sm tabular-nums text-gray-600 dark:text-muted-foreground">{article.views.toLocaleString()}</span>
        </div>
        <div className="w-[80px]">
          <span className="text-sm tabular-nums text-gray-600 dark:text-muted-foreground">{article.helpful}</span>
        </div>
        <div className="w-[120px]">
          <span className="text-sm tabular-nums">{format(article.lastUpdated, 'MMM d, yyyy')}</span>
        </div>
        <div className="w-[100px]">
          <SoftBadge tone={status.tone}>
            {(t.helpdesk.knowledge as Record<string, string>)[article.status] ?? status.label}
          </SoftBadge>
        </div>

        {rowMenu(
          article.title,
          <>
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/help-center/articles/${article.id}`} className="flex items-center">
                <Eye className="mr-0.5 h-4 w-4" />
                {kn.view}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/help-center/articles/${article.id}/edit`} className="flex items-center">
                <Edit className="mr-0.5 h-4 w-4" />
                {t.helpdesk.actions.edit}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {deleteItem(() => handleDeleteArticle(article.id))}
          </>,
        )}
      </div>
    );
  };

  // Render row (folder or article)
  const renderRow = (node: FlatNode) => {
    if (node.type === 'folder') {
      return renderFolderRow(node);
    }
    return renderArticleRow(node);
  };

  return (
    <>
      <EntityList<FlatNode>
        items={visibleNodes}
        isLoading={isLoading}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={5}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={t.helpdesk.knowledge.search}
        searchFields={['title']}
        topBarClassName="pt-2 pb-2"
        stickyOffset={-16}
        actionButtons={
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => openCreateFolderDialog(null)}
          >
            {kn.newFolder}
          </Button>
        }
        createButton={{
          label: t.helpdesk.knowledge.newArticle,
          onClick: openCreateArticleDialog,
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Article card */}
                <rect x="20" y="16" width="80" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
                <rect x="20" y="16" width="80" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Title */}
                <rect x="30" y="32" width="50" height="3.5" rx="1.75" className="fill-gray-300 dark:fill-white/20" opacity="0.7" />
                <rect x="30" y="40" width="36" height="3.5" rx="1.75" className="fill-gray-300 dark:fill-white/20" opacity="0.5" />
                {/* Divider */}
                <line x1="30" y1="52" x2="90" y2="52" className="stroke-gray-100 dark:stroke-white/10" strokeWidth="1" />
                {/* Body */}
                <rect x="30" y="60" width="60" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
                <rect x="30" y="67" width="52" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.35" />
                <rect x="30" y="74" width="56" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.3" />
                <rect x="30" y="81" width="40" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.25" />
                <rect x="30" y="88" width="48" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.2" />
                <rect x="30" y="95" width="34" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.15" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t.helpdesk.knowledge.noResults,
          description: kn.emptyStateDescription,
          action: {
            label: t.helpdesk.knowledge.newArticle,
            onClick: openCreateArticleDialog,
          },
        }}
        noResultsState={{
          title: t.helpdesk.knowledge.noResults,
          description: kn.noFilterResults,
        }}
      />

      {/* Create Folder Dialog */}
      <Dialog open={showCreateFolderDialog} onOpenChange={setShowCreateFolderDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t.helpdesk.knowledge.createNewFolder}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <label htmlFor="folderName" className="text-sm font-medium">
                {t.helpdesk.knowledge.folderName}
              </label>
              <Input
                id="folderName"
                placeholder={st('sweep.welddesk.knowledge.folderNamePlaceholder')}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleCreateFolder();
                  }
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="parentFolder">{t.helpdesk.knowledge.parentFolder}</Label>
              <Select
                value={selectedParentId || "_none"}
                onValueChange={(value) => setSelectedParentId(value === "_none" ? null : value)}
              >
                <SelectTrigger id="parentFolder">
                  <SelectValue placeholder={t.helpdesk.knowledge.noParent} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">{t.helpdesk.knowledge.noParent}</SelectItem>
                  {folders.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {'  '.repeat(folder.level)}{folder.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateFolderDialog(false)}
              disabled={isCreatingFolder}
            >
              {t.helpdesk.actions.cancel}
            </Button>
            <Button onClick={handleCreateFolder} disabled={isCreatingFolder || !newFolderName.trim()}>
              {isCreatingFolder ? t.helpdesk.knowledge.creatingFolder : t.helpdesk.knowledge.createFolder}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Folder Dialog */}
      <Dialog open={!!renameFolderId} onOpenChange={(open) => { if (!open) { setRenameFolderId(null); setRenameFolderName(""); } }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{kn.renameFolder}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <label htmlFor="renameFolderName" className="text-sm font-medium">
                {kn.folderName}
              </label>
              <Input
                id="renameFolderName"
                value={renameFolderName}
                onChange={(e) => setRenameFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameFolder();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setRenameFolderId(null); setRenameFolderName(""); }}
              disabled={updateFolderMutation.isPending}
            >
              {t.helpdesk.actions.cancel}
            </Button>
            <Button onClick={handleRenameFolder} disabled={updateFolderMutation.isPending || !renameFolderName.trim()}>
              {t.helpdesk.actions.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Article Dialog */}
      <Dialog open={showCreateArticleDialog} onOpenChange={setShowCreateArticleDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t.helpdesk.knowledge.createNewArticle}</DialogTitle>
            <DialogDescription>
              {t.helpdesk.knowledge.createArticleDesc}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="articleTitle">{t.helpdesk.knowledge.titleLabel}</Label>
              <Input
                id="articleTitle"
                placeholder={st('sweep.welddesk.knowledge.articleTitlePlaceholder')}
                value={newArticleTitle}
                onChange={(e) => setNewArticleTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newArticleTitle.trim()) {
                    handleCreateArticle();
                  }
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="articleFolder">{t.helpdesk.knowledge.collectionLabel}</Label>
              <Select
                value={selectedFolderId || ""}
                onValueChange={(value) => setSelectedFolderId(value || null)}
              >
                <SelectTrigger id="articleFolder">
                  <SelectValue placeholder={t.helpdesk.knowledge.selectCollection} />
                </SelectTrigger>
                <SelectContent>
                  {folders.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {'  '.repeat(folder.level)}{folder.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateArticleDialog(false)}
              disabled={createArticleMutation.isPending}
            >
              {t.helpdesk.actions.cancel}
            </Button>
            <Button
              onClick={handleCreateArticle}
              disabled={createArticleMutation.isPending || !newArticleTitle.trim()}
            >
              {createArticleMutation.isPending ? t.helpdesk.knowledge.creatingArticle : t.helpdesk.knowledge.createArticle}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
        title={
          pendingDelete?.kind === 'folder'
            ? t.helpdesk.helpArticles.deleteFolderTitle
            : t.helpdesk.helpArticles.deleteArticleTitle
        }
        description={
          pendingDelete?.kind === 'folder'
            ? t.helpdesk.knowledge.confirmDeleteFolder
            : t.helpdesk.knowledgeEditor.confirmDeleteArticle
        }
        confirmLabel={t.helpdesk.helpArticles.deleteItem}
        variant="destructive"
        loading={deleteArticleMutation.isPending || deleteFolderMutation.isPending}
        onConfirm={() => {
          if (pendingDelete?.kind === 'folder') deleteFolder(pendingDelete.id);
          else if (pendingDelete) deleteArticle(pendingDelete.id);
        }}
      />
    </>
  );
}
