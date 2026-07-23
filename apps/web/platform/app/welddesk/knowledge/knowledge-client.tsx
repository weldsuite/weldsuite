
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
import { Badge } from "@weldsuite/ui/components/badge";
import {
  MoreVertical,
  Edit,
  Eye,
  Trash,
  Globe,
  Lock,
  Clock,
  TrendingUp,
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
import { cn } from "@/lib/utils";
import type { StatusFilter, FilterOption, PaginationData } from "@/components/entity-overview";
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type RowHandlers } from "@/components/entity-list";
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface KnowledgeClientProps {
  items: Article[];
  pagination: PaginationData;
  params: Record<string, string>;
  statusFilters: StatusFilter[];
  additionalFilters: FilterOption[];
  counts: Record<string, number>;
}

// Status colors
const statusConfig: Record<string, { label: string; color: string }> = {
  published: {
    label: 'Published',
    color: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
  },
  draft: {
    label: 'Draft',
    color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400',
  },
  archived: {
    label: 'Archived',
    color: 'bg-gray-100 text-gray-800 dark:bg-background/20 dark:text-muted-foreground',
  },
  review: {
    label: 'Review',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400',
  },
  outdated: {
    label: 'Outdated',
    color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400',
  },
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

export function KnowledgeClient({
  items,
  pagination: initialPagination,
  params: initialSearchParams,
  statusFilters,
  additionalFilters,
  counts: initialCounts,
}: KnowledgeClientProps) {
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
    return raw.map((f: any) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId || null,
      level: f.level || 0,
      articleCount: f.articleCount || 0,
      icon: f.icon,
      color: f.color,
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

  const handleCreateFolder = async () => {
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

  const handleDeleteArticle = (id: string) => {
    if (!confirm(t.helpdesk.knowledgeEditor.confirmDeleteArticle)) return;
    deleteArticleMutation.mutate(id, {
      onSuccess: () => {
        toast.success(t.helpdesk.knowledgeEditor.articleDeleted);
        setData((prev) => prev.filter((a) => a.id !== id));
      },
      onError: () => toast.error(t.helpdesk.knowledgeEditor.failedToDeleteArticle),
    });
  };

  const handleDeleteFolder = (id: string) => {
    if (!confirm(t.helpdesk.knowledge.confirmDeleteFolder)) return;
    deleteFolderMutation.mutate(id, {
      onSuccess: async () => {
        toast.success(t.helpdesk.knowledge.folderDeleted);
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
            router.push(`/welddesk/knowledge/${result.data.id}/edit`);
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

  const getVisibilityIcon = (visibility: Article['visibility']) =>
    visibility === 'public' ? Globe : Lock;

  const getVisibilityColor = (visibility: Article['visibility']) =>
    visibility === 'public' ? 'text-blue-600' : 'text-purple-600';

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
        { value: 'internal', label: kn.filterInternal },
      ],
    },
    ...(uniqueCategories.length > 0 ? [{
      field: 'category',
      label: kn.category,
      options: uniqueCategories.map(c => ({ value: c, label: c })),
    }] : []),
  ], [uniqueCategories, kn]);

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

  // Tree line guides for indented rows
  const renderTreeLines = (node: FlatNode) => {
    if (node.depth === 0) return null;
    const INDENT = 44;
    const lines: React.ReactNode[] = [];

    // Vertical continuation lines for each ancestor level
    for (let d = 0; d < node.depth - 1; d++) {
      const ancestorIsLast = node.parentIsLast[d + 1];
      if (!ancestorIsLast) {
        lines.push(
          <span
            key={`vline-${d}`}
            className="absolute top-0 bottom-0 border-l border-gray-200 dark:border-border"
            style={{ left: `${22.5 + d * INDENT}px` }}
          />
        );
      }
    }

    // Connector for current node: L-shape (last) or T-shape (not last)
    const connectorLeft = 22.5 + (node.depth - 1) * INDENT;
    lines.push(
      <span
        key="connector"
        className="absolute border-l border-b border-gray-200 dark:border-border rounded-bl-[10px]"
        style={{
          left: `${connectorLeft}px`,
          top: 0,
          height: '50%',
          width: `${INDENT / 2 + 6}px`,
        }}
      />
    );
    // Continue vertical line below if not last sibling
    if (!node.isLast) {
      lines.push(
        <span
          key="vline-current"
          className="absolute border-l border-gray-200 dark:border-border"
          style={{
            left: `${connectorLeft}px`,
            top: '50%',
            bottom: 0,
          }}
        />
      );
    }

    return lines;
  };

  // Render row (folder or article)
  const renderRow = useCallback((node: FlatNode, handlers: RowHandlers<FlatNode>) => {
    if (node.type === 'folder') {
      return renderFolderRow(node);
    }
    return renderArticleRow(node);
  }, [expandedFolders, router, data, folders]);

  const renderFolderRow = (node: FlatNode) => {
    const folder = node.folder!;
    const isExpanded = expandedFolders.has(folder.id);
    const childCount = getFolderChildCount(folder.id);
    const FolderIcon = isExpanded ? FolderOpen : Folder;
    const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;

    return (
      <div
        key={folder.id}
        onClick={() => toggleFolder(folder.id)}
        className="relative flex items-center gap-4 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group bg-muted/30"
        style={{ paddingLeft: `${16 + node.depth * 44}px` }}
      >
        {renderTreeLines(node)}
        {/* Title with folder icon */}
        <div className="flex-1 min-w-[250px] flex items-center gap-2">
          <ChevronIcon className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 transition-transform" />
          <FolderIcon className="w-4 h-4 text-blue-500 flex-shrink-0" />
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
              {folder.name}
            </span>
            <span className="text-xs text-gray-400">
              {childCount} {childCount === 1 ? kn.itemSingular : kn.itemPlural}
            </span>
          </div>
        </div>

        {/* Empty cells to match article columns */}
        <div className="w-[100px]" />
        <div className="w-[150px]" />
        <div className="w-[80px]" />
        <div className="w-[80px]" />
        <div className="w-[120px]" />
        <div className="w-[100px]" />

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openCreateFolderDialog(folder.id)}>
                <FolderPlus className="h-4 w-4 mr-0.5" />
                {kn.newSubfolder}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setRenameFolderId(folder.id); setRenameFolderName(folder.name); }}>
                <Edit className="h-4 w-4 mr-0.5" />
                {kn.renameFolder}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleDeleteFolder(folder.id)}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                {t.helpdesk.actions.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const renderArticleRow = (node: FlatNode) => {
    const article = node.article!;
    const VisibilityIcon = getVisibilityIcon(article.visibility);
    const config = statusConfig[article.status] || statusConfig.draft;

    return (
      <div
        key={article.id}
        onClick={() => router.push(`/welddesk/knowledge/${article.id}`)}
        className="relative flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
        style={{ paddingLeft: `${16 + node.depth * 44}px` }}
      >
        {renderTreeLines(node)}
        {/* Title */}
        <div className="flex-1 min-w-[250px] flex items-center gap-2">
          <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-foreground block truncate">
              {article.title}
            </span>
            {article.excerpt && (
              <span className="text-xs text-gray-500 block truncate">{article.excerpt}</span>
            )}
          </div>
        </div>

        {/* Visibility */}
        <div className="w-[100px] flex items-center gap-1.5">
          <span className="capitalize text-sm text-gray-600 dark:text-muted-foreground">{article.visibility}</span>
        </div>

        {/* Category */}
        <div className="w-[150px]">
          {article.category ? (
            <span className="text-sm text-gray-600 dark:text-muted-foreground truncate block">{article.category}</span>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        {/* Views */}
        <div className="w-[80px] flex items-center gap-1.5">
          <span className="text-sm text-gray-600 dark:text-muted-foreground">{article.views.toLocaleString()}</span>
        </div>

        {/* Helpful */}
        <div className="w-[80px] flex items-center gap-1.5">
          <span className="text-sm text-gray-600 dark:text-muted-foreground">{article.helpful}</span>
        </div>

        {/* Last Updated */}
        <div className="w-[120px] flex items-center gap-1.5">
          <span className="text-sm text-gray-500">{format(article.lastUpdated, 'MMM d, yyyy')}</span>
        </div>

        {/* Status */}
        <div className="w-[100px]">
          <Badge className={cn("text-xs font-medium rounded-md border-transparent capitalize", config.color)}>
            {(t.helpdesk.knowledge as Record<string, string>)[article.status] ?? config.label}
          </Badge>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/welddesk/knowledge/${article.id}`} className="flex items-center">
                  <Eye className="h-4 w-4 mr-0.5" />
                  {kn.view}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/welddesk/knowledge/${article.id}/edit`} className="flex items-center">
                  <Edit className="h-4 w-4 mr-0.5" />
                  {t.helpdesk.actions.edit}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleDeleteArticle(article.id)}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                {t.helpdesk.actions.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  return (
    <>
      <EntityList<FlatNode>
        items={visibleNodes}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={5}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={t.helpdesk.knowledge.search}
        searchFields={['title']}
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
    </>
  );
}
