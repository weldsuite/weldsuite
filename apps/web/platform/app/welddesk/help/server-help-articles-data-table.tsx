
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams, Link } from '@/lib/router';
import { useAppApiClient } from "@/lib/api/use-app-api";
import {
  useHelpFolders,
  useCreateHelpFolder,
  useDeleteHelpFolder,
  useDeleteHelpArticle,
} from "@/hooks/queries/use-helpdesk-queries";
import type { Helpdesk } from "@/lib/api/types/apps/helpdesk.types";

interface HelpArticlesFilter {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  category?: string;
  folderId?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

type HelpFolder = Helpdesk.ArticleFolder;
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@weldsuite/ui/components/table";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@weldsuite/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@weldsuite/ui/components/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Settings2,
  Filter,
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  CheckCircle,
  Clock,
  Archive,
  MoreVertical,
  Eye,
  Trash2,
  Edit,
  Tag,
  ThumbsUp,
  ThumbsDown,
  FolderPlus,
  FilePlus,
  Folder,
  Plus,
} from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { Badge } from "@weldsuite/ui/components/badge";
import { format } from "date-fns";
import {
  TreeExpander,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView,
} from "@/components/kibo-ui/tree";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/provider";

interface Article {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  tags: string[];
  author: string;
  views: number;
  lastUpdated: string;
  status: string;
  helpful: number;
  notHelpful: number;
}

interface TreeNodeData {
  type: "folder" | "article";
  id?: string; // folder ID for API operations
  name: string;
  path: string;
  level: number;
  children?: TreeNodeData[];
  article?: Article;
  folder?: HelpFolder;
  isLast?: boolean;
}

interface ServerHelpArticlesDataTableProps {
  initialStatus?: string;
}

export function ServerHelpArticlesDataTable({ initialStatus = "all" }: ServerHelpArticlesDataTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const th = t.helpdesk.helpArticles;
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // State
  const [loading, setLoading] = useState(true);
  const [isFiltering, setIsFiltering] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [counts, setCounts] = useState({ total: 0, published: 0, draft: 0, archived: 0 });
  const [categories, setCategories] = useState<string[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    totalCount: 0,
    totalPages: 0,
    hasMore: false,
  });

  // Filters and sorting
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("updatedAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [showFilters, setShowFilters] = useState(false);

  // Debounced search
  const debouncedSearch = useDebounce(search, 500);

  // Column visibility
  const [visibleColumns, setVisibleColumns] = useState({
    title: true,
    tags: true,
    author: true,
    views: true,
    feedback: true,
    lastUpdated: true,
    status: true,
    actions: true,
  });

  // Folder management state
  const [folders, setFolders] = useState<HelpFolder[]>([]);
  const [showCreateFolderDialog, setShowCreateFolderDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRenameFolderDialog, setShowRenameFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ type: "folder" | "article"; id: string; name: string } | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);

  // Current folder navigation
  const [currentFolderPath, setCurrentFolderPath] = useState<string | null>(
    searchParams.get("folder") || null
  );
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);

  const { getClient } = useAppApiClient();
  const createHelpFolderMutation = useCreateHelpFolder();
  const deleteHelpFolderMutation = useDeleteHelpFolder();
  const deleteHelpArticleMutation = useDeleteHelpArticle();

  // Fetch folders via hook
  const { data: foldersQuery, refetch: refetchFolders } = useHelpFolders(true);

  useEffect(() => {
    if (foldersQuery?.success && foldersQuery?.folders) {
      setFolders(foldersQuery.folders);
    }
  }, [foldersQuery]);

  // Build tree structure from folders and articles
  const buildTree = useCallback((articles: Article[], folderData: HelpFolder[]): TreeNodeData[] => {
    const root: TreeNodeData[] = [];

    // Helper function to convert folder to TreeNode recursively
    const folderToTreeNode = (folder: HelpFolder, level: number = 0): TreeNodeData => {
      const node: TreeNodeData = {
        type: 'folder',
        id: folder.id,
        name: folder.name,
        path: folder.path || folder.name,
        level: level,
        folder: folder,
        children: []
      };

      // Add child folders
      if (folder.children) {
        folder.children.forEach(child => {
          node.children!.push(folderToTreeNode(child, level + 1));
        });
      }

      // Add articles that belong to this folder (matching by folderId or category path)
      const folderArticles = articles.filter(article => {
        // Skip placeholder articles
        if (article.title.startsWith('[Folder Placeholder]')) return false;
        // Match by category path (for backwards compatibility with old articles)
        return article.category === folder.path || article.category === folder.name;
      });

      folderArticles.forEach(article => {
        node.children!.push({
          type: 'article',
          name: article.title,
          path: `${folder.path}/${article.id}`,
          level: level + 1,
          article: article
        });
      });

      return node;
    };

    // Add folders from the API (they come as a tree already if fetched with tree=true)
    folderData.forEach(folder => {
      root.push(folderToTreeNode(folder, 0));
    });

    // Add uncategorized articles directly to root
    const uncategorizedArticles = articles.filter(article => {
      if (article.title.startsWith('[Folder Placeholder]')) return false;
      if (!article.category) return true;
      // Check if article's category doesn't match any folder
      const matchesFolder = (folders: HelpFolder[]): boolean => {
        for (const f of folders) {
          if (f.path === article.category || f.name === article.category) {
            return true;
          }
          if (f.children && matchesFolder(f.children)) {
            return true;
          }
        }
        return false;
      };
      return !matchesFolder(folderData);
    });

    uncategorizedArticles.forEach(article => {
      root.push({
        type: 'article',
        name: article.title,
        path: `root/${article.id}`,
        level: 0,
        article: article
      });
    });

    // Mark last items
    const markLast = (nodes: TreeNodeData[]) => {
      nodes.forEach((node, index) => {
        node.isLast = index === nodes.length - 1;
        if (node.children) {
          markLast(node.children);
        }
      });
    };
    markLast(root);

    return root;
  }, []);

  // Get breadcrumb parts for current folder
  const getBreadcrumbs = () => {
    if (!currentFolderPath) return [];
    const parts = currentFolderPath.split("/");
    return parts.map((part, index) => ({
      name: part,
      path: parts.slice(0, index + 1).join("/"),
    }));
  };

  // Filter tree to show only current folder contents
  const getFilteredTree = useCallback((tree: TreeNodeData[]): TreeNodeData[] => {
    if (!currentFolderPath) return tree;

    // Find the folder node matching current path
    const findFolder = (nodes: TreeNodeData[], targetPath: string): TreeNodeData | null => {
      for (const node of nodes) {
        if (node.type === "category" && node.path === targetPath) {
          return node;
        }
        if (node.children) {
          const found = findFolder(node.children, targetPath);
          if (found) return found;
        }
      }
      return null;
    };

    const currentFolder = findFolder(tree, currentFolderPath);
    if (currentFolder && currentFolder.children && currentFolder.children.length > 0) {
      // Reset levels for display and recursively fix nested children
      const resetLevels = (nodes: TreeNodeData[], baseLevel: number): TreeNodeData[] => {
        return nodes.map((child, index, arr) => ({
          ...child,
          level: baseLevel,
          isLast: index === arr.length - 1,
          children: child.children ? resetLevels(child.children, baseLevel + 1) : undefined,
        }));
      };
      return resetLevels(currentFolder.children, 0);
    }
    // Return empty array if folder not found or has no children (empty folder)
    return [];
  }, [currentFolderPath]);

  const fullTreeData = useMemo(() => buildTree(articles, folders), [articles, folders, buildTree]);
  const treeData = useMemo(
    () => getFilteredTree(fullTreeData),
    [fullTreeData, getFilteredTree]
  );

  // Filter out placeholder articles for display in table columns
  const visibleArticles = useMemo(() => {
    return articles.filter((article) => !article.title.startsWith("[Folder Placeholder]"));
  }, [articles]);

  // Get visible articles for current folder view
  const currentFolderArticles = useMemo(() => {
    if (!currentFolderPath) {
      // Root view - show articles without category OR in root-level categories
      return visibleArticles.filter((article) => !article.category?.trim());
    }
    // Folder view - show only direct children of current folder
    return visibleArticles.filter((article) => article.category === currentFolderPath);
  }, [visibleArticles, currentFolderPath]);

  // Get all category paths for default expansion
  const defaultExpandedIds = useMemo(() => {
    const ids: string[] = [];
    const traverse = (nodes: TreeNodeData[]) => {
      nodes.forEach((node) => {
        if (node.type === "category") {
          ids.push(node.path);
          if (node.children) traverse(node.children);
        }
      });
    };
    traverse(treeData);
    return ids;
  }, [treeData]);

  // Breadcrumbs for folder navigation
  const breadcrumbs = getBreadcrumbs();

  // Fetch articles from server using direct API call
  const loadArticles = useCallback(async () => {
    setIsFiltering(true);

    const filters: HelpArticlesFilter = {
      page: pagination.page,
      limit: pagination.limit,
      status: statusFilter,
      search: debouncedSearch,
      category: categoryFilter,
      sortBy,
      sortOrder,
    };

    // TODO(welddesk-help-articles): NO DATA SOURCE — this table always renders
    // empty, exactly as it does in production today.
    //
    // It used to GET `/helpdesk/help/articles` on api-worker, but that router
    // mounts no `/help` at all, so the call 404'd, hit the catch, and the table
    // rendered empty. The dead request is dropped rather than repointed: it kept
    // the retiring api-worker client alive for a call that could only fail.
    //
    // app-api's `GET /api/articles` is NOT a drop-in. This table needs one
    // aggregate response — `{ articles, pagination: { page, ... }, counts:
    // { total, published, draft, archived }, categories }` — whereas /api/articles
    // returns `{ data, pagination: { totalCount, hasMore, cursor } }`: no counts,
    // no categories, and opaque cursor paging behind a numbered pager. Wiring this
    // up means adding that aggregate to app-api first (or reworking the table to
    // cursor paging plus separate counts/categories calls).
    setArticles([]);
    setCounts({ total: 0, published: 0, draft: 0, archived: 0 });
    setCategories([]);
    setLoading(false);
    setIsFiltering(false);

    // Keep the URL in sync with the active filters, as before.
    const newParams = new URLSearchParams(searchParams?.toString() || "");
    newParams.set("page", String(filters.page ?? 1));
    newParams.set("status", statusFilter);
    if (debouncedSearch) {
      newParams.set("search", debouncedSearch);
    } else {
      newParams.delete("search");
    }
    if (categoryFilter !== "all") {
      newParams.set("category", categoryFilter);
    } else {
      newParams.delete("category");
    }
    router.replace(`?${newParams.toString()}`, { scroll: false });
  }, [
    pagination.page,
    pagination.limit,
    statusFilter,
    categoryFilter,
    debouncedSearch,
    sortBy,
    sortOrder,
    router,
    searchParams,
  ]);

  // Fetch articles when dependencies change
  useEffect(() => {
    loadArticles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pagination.page,
    pagination.limit,
    statusFilter,
    categoryFilter,
    debouncedSearch,
    sortBy,
    sortOrder,
  ]);

  // Reset page when filters change
  useEffect(() => {
    setPagination((prev) => ({ ...prev, page: 1 }));
  }, [statusFilter, categoryFilter, debouncedSearch]);

  // Handle sort
  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(field);
      setSortOrder("asc");
    }
  };

  // Export data
  const handleExport = async () => {
    const filters: HelpArticlesFilter = {
      status: statusFilter,
      search: search,
      category: categoryFilter,
      sortBy,
      sortOrder,
    };
    try {
      // Exports the rows currently loaded in the table.
      //
      // TODO(welddesk-help-articles): this used to re-fetch every match at
      // `limit=1000` so the CSV covered ALL pages, not just the visible one. That
      // fetch hit the same dead `/helpdesk/help/articles` as loadArticles, so it
      // threw and produced no file at all. Sourcing from state keeps the export
      // working once the table has a data source again — but it will then export
      // only the current page, so restore an export-all fetch alongside the
      // aggregate endpoint (note app-api caps `limit` at 100, so export-all needs
      // paging, not `limit=1000`).
      const allArticles = articles;

      // Create CSV
      const headers = [];
      const keys: string[] = [];

      if (visibleColumns.title) {
        headers.push("Title");
        keys.push("title");
      }
      headers.push("Category");
      keys.push("category");
      if (visibleColumns.tags) {
        headers.push("Tags");
        keys.push("tags");
      }
      if (visibleColumns.author) {
        headers.push("Author");
        keys.push("author");
      }
      if (visibleColumns.views) {
        headers.push("Views");
        keys.push("views");
      }
      if (visibleColumns.feedback) {
        headers.push("Helpful");
        keys.push("helpful");
        headers.push("Not Helpful");
        keys.push("notHelpful");
      }
      if (visibleColumns.lastUpdated) {
        headers.push("Last Updated");
        keys.push("lastUpdated");
      }
      if (visibleColumns.status) {
        headers.push("Status");
        keys.push("status");
      }

      const csvHeaders = headers.join(",");
      const csvRows = allArticles.map((article: Article) =>
        keys
          .map((key) => {
            let value = "";
            if (key === "tags") value = article.tags?.join("; ") || "";
            else if (key === "lastUpdated")
              value = article.lastUpdated
                ? new Date(article.lastUpdated).toLocaleDateString()
                : "";
            else value = (article as any)[key]?.toString() || "";
            return `"${value}"`;
          })
          .join(",")
      );

      const csv = [csvHeaders, ...csvRows].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `help-articles-${new Date().toISOString().split("T")[0]}.csv`;
      link.click();
    } catch (error) {
      console.error("Error exporting help articles:", error);
    }
  };

  // Status icon component
  const StatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case "published":
        return <CheckCircle className="mr-1 h-3 w-3" />;
      case "draft":
        return <FileText className="mr-1 h-3 w-3" />;
      case "archived":
        return <Archive className="mr-1 h-3 w-3" />;
      default:
        return null;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "published":
        return "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/20";
      case "draft":
        return "bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-300 hover:bg-yellow-50 dark:hover:bg-yellow-900/20";
      case "archived":
        return "bg-gray-50 text-gray-700 dark:bg-background/20 dark:text-muted-foreground hover:bg-gray-50 dark:hover:bg-background/20";
      default:
        return "";
    }
  };

  // Refresh folders helper
  const refreshFolders = async () => {
    await refetchFolders();
  };

  // Folder management handlers
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    setIsCreatingFolder(true);
    createHelpFolderMutation.mutate(
      {
        name: newFolderName.trim(),
        parentId: selectedFolderId || undefined,
        parentPath: selectedFolderPath || undefined,
      },
      {
        onSuccess: () => {
          toast.success(th.createdFolderSuccess.replace('{name}', newFolderName));
          setShowCreateFolderDialog(false);
          setNewFolderName("");
          setSelectedFolderId(null);
          setSelectedFolderPath(null);
          refreshFolders();
          loadArticles();
        },
        onError: () => {
          toast.error(th.failedToCreateFolder);
        },
        onSettled: () => {
          setIsCreatingFolder(false);
        },
      }
    );
  };

  const handleRenameFolder = async () => {
    if (!renameFolderTarget || !newFolderName.trim()) return;

    setIsRenaming(true);
    try {
      const client = await getClient();
      await client.patch(`/article-folders/${renameFolderTarget.id}`, {
        name: newFolderName.trim(),
      });
      toast.success(th.renamedFolderSuccess.replace('{name}', newFolderName));
      setShowRenameFolderDialog(false);
      setNewFolderName("");
      setRenameFolderTarget(null);
      await refreshFolders();
    } catch (error) {
      toast.error(th.failedToRenameFolder);
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    try {
      if (deleteTarget.type === "folder") {
        await new Promise<void>((resolve, reject) => {
          deleteHelpFolderMutation.mutate({ id: deleteTarget.id }, {
            onSuccess: () => {
              toast.success(th.deletedFolderSuccess.replace('{name}', deleteTarget.name));
              refreshFolders();
              resolve();
            },
            onError: (error: any) => {
              toast.error(error?.message || th.failedToDeleteFolder);
              reject(error);
            },
          });
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          deleteHelpArticleMutation.mutate(deleteTarget.id, {
            onSuccess: () => {
              toast.success(th.deletedArticleSuccess.replace('{name}', deleteTarget.name));
              resolve();
            },
            onError: (error: any) => {
              toast.error(error?.message || th.failedToDeleteArticle);
              reject(error);
            },
          });
        });
      }
      setShowDeleteDialog(false);
      setDeleteTarget(null);
      loadArticles();
    } catch (error) {
      toast.error(th.failedToDelete);
    }
  };

  const openCreateFolderDialog = (parentId: string | null = null, parentPath: string | null = null) => {
    setSelectedFolderId(parentId);
    setSelectedFolderPath(parentPath);
    setNewFolderName("");
    setShowCreateFolderDialog(true);
  };

  const openRenameFolderDialog = (id: string, name: string) => {
    setRenameFolderTarget({ id, name });
    setNewFolderName(name);
    setShowRenameFolderDialog(true);
  };

  const openDeleteDialog = (type: "folder" | "article", id: string, name: string) => {
    setDeleteTarget({ type, id, name });
    setShowDeleteDialog(true);
  };

  // Navigate to a folder
  const navigateToFolder = (folderPath: string | null) => {
    setCurrentFolderPath(folderPath);
    const params = new URLSearchParams(searchParams.toString());
    if (folderPath) {
      params.set("folder", folderPath);
    } else {
      params.delete("folder");
    }
    params.set("page", "1");
    router.push(`/welddesk/help?${params.toString()}`);
  };

  // Render tree nodes recursively with context menus
  const renderTreeNodes = (nodes: TreeNodeData[]): React.ReactNode => {
    return nodes.map((node) => {
      if (node.type === "folder") {
        const hasChildren = node.children && node.children.length > 0;
        const folderId = node.id || node.folder?.id;
        return (
          <TreeNode key={node.path} nodeId={node.path} level={node.level} isLast={node.isLast}>
            <TreeNodeTrigger>
              <TreeExpander hasChildren={hasChildren} />
              <TreeIcon hasChildren />
              <Button
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  navigateToFolder(node.path);
                }}
                className="hover:text-primary hover:underline underline-offset-4 text-left"
              >
                <TreeLabel>{node.name}</TreeLabel>
              </Button>
              <div className="ml-auto flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shadow-none">
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={() => navigateToFolder(node.path)}>
                      <Folder className="h-4 w-4 mr-0.5" />
                      {th.openFolder}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => openCreateFolderDialog(folderId || null, node.path)}>
                      <FolderPlus className="h-4 w-4 mr-0.5" />
                      {th.newSubfolder}
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href={`/welddesk/help/new?category=${encodeURIComponent(node.path)}`}>
                        <FilePlus className="h-4 w-4 mr-0.5" />
                        {th.newArticle}
                      </Link>
                    </DropdownMenuItem>
                    {folderId && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => openRenameFolderDialog(folderId, node.name)}>
                          <Edit className="h-4 w-4 mr-0.5" />
                          {th.renameFolder}
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => folderId && openDeleteDialog("folder", folderId, node.name)}
                      disabled={!folderId}
                    >
                      <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                      {th.deleteFolder}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TreeNodeTrigger>
            {hasChildren && (
              <TreeNodeContent hasChildren>
                {renderTreeNodes(node.children!)}
              </TreeNodeContent>
            )}
          </TreeNode>
        );
      } else {
        const article = node.article!;
        return (
          <TreeNode key={node.path} nodeId={node.path} level={node.level} isLast={node.isLast}>
            <TreeNodeTrigger>
              <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <Link
                href={`/welddesk/help/${article.id}`}
                className="hover:text-primary hover:underline underline-offset-4"
                onClick={(e) => e.stopPropagation()}
              >
                <TreeLabel>{article.title}</TreeLabel>
              </Link>
              <div className="ml-auto flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shadow-none">
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem asChild>
                      <Link href={`/welddesk/help/${article.id}`}>
                        <Eye className="h-4 w-4 mr-0.5" />
                        {th.viewArticle}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href={`/welddesk/help/${article.id}/edit`}>
                        <Edit className="h-4 w-4 mr-0.5" />
                        {th.editArticle}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => openDeleteDialog("article", article.id, article.title)}
                    >
                      <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                      {th.deleteArticle}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TreeNodeTrigger>
          </TreeNode>
        );
      }
    });
  };

  return (
    <div className="space-y-4">
      {/* Controls Bar with Status Filters and Search */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Status Filter Buttons */}
          <Button
            variant={statusFilter === "all" ? "default" : "outline"}
            onClick={() => setStatusFilter("all")}
            className="h-8 text-sm px-3 transition-all duration-200 relative overflow-hidden shadow-none"
            disabled={isFiltering}
          >
            <span className="relative z-10">{th.allArticles}</span>
            <span className="relative z-10 -ml-0.5 transition-all duration-300">
              ({counts.total})
            </span>
          </Button>
          <Button
            variant={statusFilter === "published" ? "default" : "outline"}
            onClick={() => setStatusFilter("published")}
            className="h-8 text-sm px-3 transition-all duration-200 relative overflow-hidden shadow-none"
            disabled={isFiltering}
          >
            <span className="relative z-10">{th.published}</span>
            <span className="relative z-10 -ml-0.5 transition-all duration-300">
              ({counts.published})
            </span>
          </Button>
          <Button
            variant={statusFilter === "draft" ? "default" : "outline"}
            onClick={() => setStatusFilter("draft")}
            className="h-8 text-sm px-3 transition-all duration-200 relative overflow-hidden shadow-none"
            disabled={isFiltering}
          >
            <span className="relative z-10">{th.draft}</span>
            <span className="relative z-10 -ml-0.5 transition-all duration-300">
              ({counts.draft})
            </span>
          </Button>
          <Button
            variant={statusFilter === "archived" ? "default" : "outline"}
            onClick={() => setStatusFilter("archived")}
            className="h-8 text-sm px-3 transition-all duration-200 relative overflow-hidden shadow-none"
            disabled={isFiltering}
          >
            <span className="relative z-10">{th.archived}</span>
            <span className="relative z-10 -ml-0.5 transition-all duration-300">
              ({counts.archived})
            </span>
          </Button>

          {/* Clear Filters */}
          {(search || categoryFilter !== "all") && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch("");
                setCategoryFilter("all");
              }}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              disabled={isFiltering}
            >
              {th.clear}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Filter Toggle */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className={`h-8 w-8 p-0 transition-all duration-200 shadow-none ${showFilters ? "bg-muted" : ""}`}
              disabled={isFiltering}
            >
              <Filter className="h-4 w-4" />
            </Button>
            {categoryFilter !== "all" && (
              <span className="absolute -top-1 -right-1 h-3 w-3 bg-primary rounded-full text-[9px] text-white flex items-center justify-center">
                1
              </span>
            )}
          </div>

          {/* Column Settings */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shadow-none">
                <Settings2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs">{th.columns}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {Object.entries(visibleColumns)
                .filter(([key]) => key !== "actions")
                .map(([key, visible]) => (
                  <DropdownMenuCheckboxItem
                    key={key}
                    checked={visible}
                    onCheckedChange={(checked) =>
                      setVisibleColumns((prev) => ({ ...prev, [key]: checked }))
                    }
                    className="text-sm capitalize"
                  >
                    {key === "lastUpdated" ? th.lastUpdated : key}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Export */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExport}
            className="h-8 w-8 p-0 transition-all duration-200 shadow-none"
            disabled={isFiltering}
          >
            <Download className="h-4 w-4" />
          </Button>

          {/* New Folder */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => openCreateFolderDialog(currentFolderPath)}
            className="h-8 px-3 text-sm transition-all duration-200 shadow-none"
            disabled={isFiltering}
          >
            <FolderPlus className="h-4 w-4 mr-0.5" />
            {th.newFolder}
          </Button>

          {/* Search */}
          <div className="relative ml-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
            <Input
              placeholder={th.searchArticles}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-9 w-[250px] text-sm border border-border/50 bg-white dark:bg-background focus:bg-white dark:focus:bg-background shadow-none transition-all duration-200"
              disabled={isFiltering}
            />
            {debouncedSearch && isFiltering && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2">
                <div className="h-3 w-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {/* Folder Breadcrumb Navigation */}
        {currentFolderPath && (
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-md border border-border/50">
            <Button
              variant="ghost"
              onClick={() => navigateToFolder(null)}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {th.allArticles}
            </Button>
            {breadcrumbs.map((crumb, index) => (
              <div key={crumb.path} className="flex items-center gap-2">
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                {index === breadcrumbs.length - 1 ? (
                  <span className="text-sm font-medium">{crumb.name}</span>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => navigateToFolder(crumb.path)}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {crumb.name}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Filter Row */}
        {showFilters && (
          <div className="flex flex-wrap gap-2 p-3 bg-gray-50 dark:bg-background/50 rounded-md border border-border/50 transition-all duration-300">
            <div className="flex flex-col gap-0.5">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide px-1">
                {th.category}
              </label>
              <Select
                value={categoryFilter}
                onValueChange={setCategoryFilter}
                disabled={isFiltering}
              >
                <SelectTrigger className="!h-[36px] !py-1 w-[180px] text-sm transition-all duration-200 shadow-none border border-border/50 bg-white dark:bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{th.allCategories}</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {/* Table */}
        <div
          ref={tableContainerRef}
          className="rounded-md border border-border/50 overflow-hidden"
          style={{
            minHeight: loading ? "400px" : articles.length === 0 ? "200px" : "auto",
          }}
        >
          <div className={`${isFiltering ? "no-scrollbar-transition" : ""}`}>
            <Table className="w-full min-w-[1000px]">
              <TableHeader className="sticky top-0 z-5 bg-background">
                <TableRow className="border-b border-border/50">
                  {visibleColumns.title && (
                    <TableHead className="h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap min-w-[300px]">
                      <Button
                        variant="ghost"
                        onClick={() => handleSort("title")}
                        className="inline-flex items-center gap-1 hover:text-foreground transition-all duration-200 disabled:opacity-50"
                        disabled={isFiltering}
                      >
                        {th.titleColumn}
                        {sortBy === "title" ? (
                          sortOrder === "asc" ? (
                            <ArrowUp className="h-3 w-3 text-primary" />
                          ) : (
                            <ArrowDown className="h-3 w-3 text-primary" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30 hover:opacity-50" />
                        )}
                      </Button>
                    </TableHead>
                  )}
                  {visibleColumns.tags && (
                    <TableHead className="h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                      {th.tags}
                    </TableHead>
                  )}
                  {visibleColumns.author && (
                    <TableHead className="h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                      {th.author}
                    </TableHead>
                  )}
                  {visibleColumns.views && (
                    <TableHead className="h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground text-right">
                      <Button
                        variant="ghost"
                        onClick={() => handleSort("views")}
                        className="inline-flex items-center gap-1 hover:text-foreground transition-all duration-200 disabled:opacity-50"
                        disabled={isFiltering}
                      >
                        {th.views}
                        {sortBy === "views" ? (
                          sortOrder === "asc" ? (
                            <ArrowUp className="h-3 w-3 text-primary" />
                          ) : (
                            <ArrowDown className="h-3 w-3 text-primary" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30 hover:opacity-50" />
                        )}
                      </Button>
                    </TableHead>
                  )}
                  {visibleColumns.feedback && (
                    <TableHead className="h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground text-right">
                      {th.feedback}
                    </TableHead>
                  )}
                  {visibleColumns.lastUpdated && (
                    <TableHead className="h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground">
                      <Button
                        variant="ghost"
                        onClick={() => handleSort("updatedAt")}
                        className="inline-flex items-center gap-1 hover:text-foreground transition-all duration-200 disabled:opacity-50"
                        disabled={isFiltering}
                      >
                        {th.lastUpdated}
                        {sortBy === "updatedAt" ? (
                          sortOrder === "asc" ? (
                            <ArrowUp className="h-3 w-3 text-primary" />
                          ) : (
                            <ArrowDown className="h-3 w-3 text-primary" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30 hover:opacity-50" />
                        )}
                      </Button>
                    </TableHead>
                  )}
                  {visibleColumns.status && (
                    <TableHead className="h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground text-left">
                      <Button
                        variant="ghost"
                        onClick={() => handleSort("status")}
                        className="inline-flex items-center gap-1 hover:text-foreground transition-all duration-200 disabled:opacity-50"
                        disabled={isFiltering}
                      >
                        {th.status}
                        {sortBy === "status" ? (
                          sortOrder === "asc" ? (
                            <ArrowUp className="h-3 w-3 text-primary" />
                          ) : (
                            <ArrowDown className="h-3 w-3 text-primary" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30 hover:opacity-50" />
                        )}
                      </Button>
                    </TableHead>
                  )}
                  {visibleColumns.actions && (
                    <TableHead className="h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground text-right"></TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody className="relative" style={{ overflow: "hidden" }}>
                {loading ? (
                  // Skeleton loading rows
                  Array.from({ length: 10 }).map((_, index) => (
                    <TableRow key={`skeleton-${index}`} className="border-b border-border/30">
                      {visibleColumns.title && (
                        <TableCell className="px-3 py-3">
                          <div className="h-4 bg-muted animate-pulse rounded w-48"></div>
                        </TableCell>
                      )}
                      {visibleColumns.tags && (
                        <TableCell className="px-3 py-3">
                          <div className="h-4 bg-muted animate-pulse rounded w-32"></div>
                        </TableCell>
                      )}
                      {visibleColumns.author && (
                        <TableCell className="px-3 py-3">
                          <div className="h-4 bg-muted animate-pulse rounded w-24"></div>
                        </TableCell>
                      )}
                      {visibleColumns.views && (
                        <TableCell className="px-3 py-3 text-right">
                          <div className="h-4 bg-muted animate-pulse rounded w-12 ml-auto"></div>
                        </TableCell>
                      )}
                      {visibleColumns.feedback && (
                        <TableCell className="px-3 py-3 text-right">
                          <div className="h-4 bg-muted animate-pulse rounded w-16 ml-auto"></div>
                        </TableCell>
                      )}
                      {visibleColumns.lastUpdated && (
                        <TableCell className="px-3 py-3">
                          <div className="h-4 bg-muted animate-pulse rounded w-24"></div>
                        </TableCell>
                      )}
                      {visibleColumns.status && (
                        <TableCell className="px-3 py-3 text-left">
                          <div className="h-6 bg-muted animate-pulse rounded-full w-20"></div>
                        </TableCell>
                      )}
                      {visibleColumns.actions && (
                        <TableCell className="px-3 py-3 text-right">
                          <div className="h-7 bg-muted animate-pulse rounded w-8 ml-auto"></div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                ) : treeData.length === 0 && currentFolderArticles.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={Object.values(visibleColumns).filter(Boolean).length}
                      className="text-center text-muted-foreground"
                    >
                      <div className="space-y-2 py-8">
                        <FileText className="h-12 w-12 mx-auto text-muted-foreground/30" />
                        <p className="font-medium">{th.noHelpArticlesFound}</p>
                        <p className="text-xs text-muted-foreground">
                          {th.tryAdjustingFilters}
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow>
                    {visibleColumns.title && (
                      <TableCell className="px-3 py-3 align-top">
                        <TreeProvider
                          defaultExpandedIds={defaultExpandedIds}
                          onSelectionChange={() => {}}
                        >
                          <TreeView>
                            {renderTreeNodes(treeData)}
                          </TreeView>
                        </TreeProvider>
                      </TableCell>
                    )}
                    {visibleColumns.tags && (
                      <TableCell className="px-3 py-3 align-top">
                        <div className="space-y-2">
                          {currentFolderArticles.map((article) => (
                            <div key={article.id} className="flex flex-wrap gap-1 py-1">
                              {article.tags?.slice(0, 2).map((tag: string) => (
                                <Badge key={tag} variant="outline" className="text-xs">
                                  <Tag className="h-2.5 w-2.5 mr-1" />
                                  {tag}
                                </Badge>
                              ))}
                              {article.tags?.length > 2 && (
                                <Badge variant="outline" className="text-xs">
                                  +{article.tags.length - 2}
                                </Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.author && (
                      <TableCell className="px-3 py-3 align-top">
                        <div className="space-y-2">
                          {currentFolderArticles.map((article) => (
                            <div key={article.id} className="py-1">
                              <span className="text-sm text-muted-foreground">
                                {article.author || "-"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.views && (
                      <TableCell className="px-3 py-3 align-top text-right">
                        <div className="space-y-2">
                          {currentFolderArticles.map((article) => (
                            <div key={article.id} className="flex items-center justify-end gap-1.5 py-1">
                              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="font-medium text-sm">
                                {article.views?.toLocaleString() || 0}
                              </span>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.feedback && (
                      <TableCell className="px-3 py-3 align-top text-right">
                        <div className="space-y-2">
                          {currentFolderArticles.map((article) => (
                            <div key={article.id} className="flex items-center justify-end gap-2 py-1">
                              <div className="flex items-center gap-1">
                                <ThumbsUp className="h-3.5 w-3.5 text-green-600" />
                                <span className="text-sm text-green-600">{article.helpful || 0}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <ThumbsDown className="h-3.5 w-3.5 text-red-500" />
                                <span className="text-sm text-red-500">{article.notHelpful || 0}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.lastUpdated && (
                      <TableCell className="px-3 py-3 align-top">
                        <div className="space-y-2">
                          {currentFolderArticles.map((article) => (
                            <div key={article.id} className="flex items-center gap-1.5 text-sm text-muted-foreground py-1">
                              <Clock className="h-3.5 w-3.5" />
                              <span>
                                {article.lastUpdated
                                  ? format(new Date(article.lastUpdated), "MMM d, yyyy")
                                  : "-"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.status && (
                      <TableCell className="px-3 py-3 align-top">
                        <div className="space-y-2">
                          {currentFolderArticles.map((article) => (
                            <div key={article.id} className="py-1">
                              <Badge
                                variant="outline"
                                className={`inline-flex items-center transition-all duration-200 ${getStatusColor(article.status)}`}
                              >
                                <StatusIcon status={article.status} />
                                {article.status?.charAt(0).toUpperCase() + article.status?.slice(1)}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.actions && (
                      <TableCell className="px-3 py-3 align-top text-right">
                        <div className="space-y-2">
                          {currentFolderArticles.map((article) => (
                            <div key={article.id} className="flex items-center justify-end gap-1 py-1">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0 shadow-none hover:bg-muted"
                                  >
                                    <MoreVertical className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                  <DropdownMenuItem asChild>
                                    <Link
                                      href={`/welddesk/help/${article.id}`}
                                      className="flex items-center"
                                    >
                                      <Eye className="h-4 w-4 mr-0.5" />
                                      {th.viewArticle}
                                    </Link>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem asChild>
                                    <Link
                                      href={`/welddesk/help/${article.id}/edit`}
                                      className="flex items-center"
                                    >
                                      <Edit className="h-4 w-4 mr-0.5" />
                                      {th.editArticle}
                                    </Link>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem className="flex items-center text-destructive focus:text-destructive">
                                    <Trash2 className="h-4 w-4 mr-0.5 text-destructive" />
                                    {th.deleteArticle}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Pagination Footer */}
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            {th.showing} {(pagination.page - 1) * pagination.limit + 1} {th.to}{" "}
            {Math.min(pagination.page * pagination.limit, pagination.totalCount)} {th.of}{" "}
            {pagination.totalCount} {th.items}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPagination((prev) => ({ ...prev, page: 1 }))}
              disabled={pagination.page === 1 || isFiltering}
              className="h-8 w-8 shadow-none"
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPagination((prev) => ({ ...prev, page: prev.page - 1 }))}
              disabled={pagination.page === 1 || isFiltering}
              className="h-8 w-8 shadow-none"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <span className="px-2 text-sm text-muted-foreground">
              {th.page}{" "}
              <span className="font-medium text-foreground">{pagination.page}</span> {th.of}{" "}
              <span className="font-medium text-foreground">{pagination.totalPages}</span>
            </span>

            <Button
              variant="outline"
              size="icon"
              onClick={() => setPagination((prev) => ({ ...prev, page: prev.page + 1 }))}
              disabled={!pagination.hasMore || isFiltering}
              className="h-8 w-8 shadow-none"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPagination((prev) => ({ ...prev, page: pagination.totalPages }))}
              disabled={!pagination.hasMore || isFiltering}
              className="h-8 w-8 shadow-none"
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Create Folder Dialog */}
      <Dialog open={showCreateFolderDialog} onOpenChange={setShowCreateFolderDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{th.createNewFolder}</DialogTitle>
            <DialogDescription>
              {selectedFolderPath
                ? th.createSubfolderIn.replace('{path}', selectedFolderPath)
                : th.createRootFolder}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <label htmlFor="folderName" className="text-sm font-medium">
                {th.folderName}
              </label>
              <Input
                id="folderName"
                placeholder={th.folderNamePlaceholder}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleCreateFolder();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateFolderDialog(false)}
              disabled={isCreatingFolder}
            >
              {th.cancel}
            </Button>
            <Button onClick={handleCreateFolder} disabled={isCreatingFolder || !newFolderName.trim()}>
              {isCreatingFolder ? th.creating : th.createFolder}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Folder Dialog */}
      <Dialog open={showRenameFolderDialog} onOpenChange={setShowRenameFolderDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{th.renameFolder}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <label htmlFor="renameFolderName" className="text-sm font-medium">
                {th.renameFolderNewName}
              </label>
              <Input
                id="renameFolderName"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleRenameFolder();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRenameFolderDialog(false)}
              disabled={isRenaming}
            >
              {th.cancel}
            </Button>
            <Button onClick={handleRenameFolder} disabled={isRenaming || !newFolderName.trim()}>
              {isRenaming ? th.renaming : th.renameFolder}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title={deleteTarget?.type === "folder" ? th.deleteFolderTitle : th.deleteArticleTitle}
        description={
          deleteTarget?.type === "folder"
            ? th.deleteFolderConfirm.replace('{name}', deleteTarget?.name ?? '')
            : th.deleteArticleConfirm.replace('{name}', deleteTarget?.name ?? '')
        }
        confirmLabel={th.deleteItem}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
