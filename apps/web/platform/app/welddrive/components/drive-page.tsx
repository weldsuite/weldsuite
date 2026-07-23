import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/provider';
import {
  Upload,
  LayoutGrid,
  List,
  ChevronLeft,
  ChevronRight,
  Star,
  FolderOpen,
  Folder,
  Search,
  Plus,
  MoreVertical,
  ExternalLink,
  Download,
  Pencil,
  FolderInput,
  Link,
  Trash,
  Trash2,
  Info,
  Copy,
  RotateCcw,
  X,
  FileText,
  FolderPlus,
  FileUp,
  FolderUp,
  Loader2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { FilePreviewModal } from './file-preview-modal';
import { CreateFolderDialog } from './create-folder-dialog';
import { RenameDialog } from '@/app/weldcrm/components/rename-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { MoveToFolderDialog } from './move-to-folder-dialog';
import { FileDetailPanel } from './file-detail-panel';
import { DriveFileCard, downloadFile, fileTypeIcons, sourceBadgeStyles, driveLabelClass, formatFileSize, formatDate } from './drive-file-card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { DriveFolderCard } from './drive-folder-card';
import { useAllFiles, useDriveFiles, useDriveFolders, useAllDriveFolders, useDriveStats, useStarDriveFile, useUpdateDriveFile, useDeleteDriveFile, useMoveDriveFile, useCreateDriveFile, useCreateDriveFolder, useUpdateDriveFolder, useDeleteDriveFolder, useDriveTrash, useRestoreDriveFile, useRestoreDriveFolder, usePermanentDeleteDriveFile, usePermanentDeleteDriveFolder, useEmptyDriveTrash } from '@/hooks/queries/use-drive-queries';
import { useFileUpload } from '@/hooks/use-file-upload';
import { toast } from 'sonner';
import type { UnifiedFile, DriveFolder, DriveFilesParams } from '@/lib/api/domains/welddrive';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type ActiveFilter, type SortState, type RowHandlers } from '@/components/entity-list';
import { FilterPills } from '@/components/entity-list';
import { createDocument } from '@/lib/documents/api';

type ViewMode = 'grid' | 'list';

export type DriveView = 'my-drive' | 'all-files' | 'recent' | 'starred' | 'shared' | 'uploads' | 'trash';

export interface DrivePageProps {
  view?: DriveView;
  typeFilter?: string;
  sourceFilter?: string;
  folderId?: string | null;
}

// Wrapper to give folders+files a unified shape for EntityList
interface DriveItem {
  id: string;
  kind: 'folder' | 'file';
  name: string;
  fileType: string;
  source: string;
  sourceLabel: string;
  fileSize: number | null;
  createdAt: string;
  isStarred: boolean;
  depth: number;
  _file?: UnifiedFile;
  _folder?: DriveFolder;
}

function toItems(folders: DriveFolder[], files: UnifiedFile[], depth = 0): DriveItem[] {
  const folderItems: DriveItem[] = folders.map(f => ({
    id: `folder-${f.id}`,
    kind: 'folder',
    name: f.name,
    fileType: 'folder',
    source: 'drive',
    sourceLabel: 'Drive',
    fileSize: null,
    createdAt: f.createdAt,
    isStarred: false,
    depth,
    _folder: f,
  }));
  const fileItems: DriveItem[] = files.map(f => ({
    id: `${f.source}-${f.id}`,
    kind: 'file',
    name: f.name,
    fileType: f.fileType,
    source: f.source,
    sourceLabel: f.sourceLabel,
    fileSize: f.fileSize,
    createdAt: f.createdAt,
    isStarred: f.isStarred,
    depth,
    _file: f,
  }));
  return [...folderItems, ...fileItems];
}

function buildTreeItems(
  allFolders: DriveFolder[],
  allFiles: UnifiedFile[],
  expandedFolders: Set<string>,
  parentId: string | null = null,
  depth = 0,
): DriveItem[] {
  const result: DriveItem[] = [];
  const childFolders = allFolders.filter(f => (f.parentId || null) === parentId);
  const childFiles = parentId
    ? allFiles.filter(f => f.folderId === parentId)
    : allFiles.filter(f => !f.folderId);

  for (const folder of childFolders) {
    result.push({
      id: `folder-${folder.id}`,
      kind: 'folder',
      name: folder.name,
      fileType: 'folder',
      source: 'drive',
      sourceLabel: 'Drive',
      fileSize: null,
      createdAt: folder.createdAt,
      isStarred: false,
      depth,
      _folder: folder,
    });
    if (expandedFolders.has(folder.id)) {
      const children = buildTreeItems(allFolders, allFiles, expandedFolders, folder.id, depth + 1);
      if (children.length > 0) {
        result.push(...children);
      } else {
        result.push({
          id: `empty-${folder.id}`,
          kind: 'file',
          name: '',
          fileType: '_empty',
          source: 'drive',
          sourceLabel: '',
          fileSize: null,
          createdAt: '',
          isStarred: false,
          depth: depth + 1,
        });
      }
    }
  }

  for (const file of childFiles) {
    result.push({
      id: `${file.source}-${file.id}`,
      kind: 'file',
      name: file.name,
      fileType: file.fileType,
      source: file.source,
      sourceLabel: file.sourceLabel,
      fileSize: file.fileSize,
      createdAt: file.createdAt,
      isStarred: file.isStarred,
      depth,
      _file: file,
    });
  }

  return result;
}

export function DrivePage({ view = 'my-drive', typeFilter, sourceFilter, folderId: initialFolderId }: DrivePageProps) {
  const navigate = useNavigate();
  const { t } = useI18n();

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sortBy, setSortBy] = useState<string>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(initialFolderId || null);
  const sidebarView: DriveView = view;
  const activeTypeFilter = typeFilter || '';
  const activeSourceFilter = sourceFilter || '';
  const [previewFile, setPreviewFile] = useState<UnifiedFile | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(1);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [renameFile, setRenameFile] = useState<UnifiedFile | null>(null);
  const [detailFile, setDetailFile] = useState<UnifiedFile | null>(null);
  const [deleteFile, setDeleteFile] = useState<UnifiedFile | null>(null);
  const [moveFile, setMoveFile] = useState<UnifiedFile | null>(null);
  const [renameFolder, setRenameFolder] = useState<DriveFolder | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<DriveFolder | null>(null);
  const [fileComments, setFileComments] = useState<Record<string, any[]>>({});
  const [fileDescriptions, setFileDescriptions] = useState<Record<string, string>>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedIdRef = useRef<string | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    lastSelectedIdRef.current = null;
  }, []);

  // Escape to deselect
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [clearSelection]);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<{ name: string; iconHtml: string; x: number; y: number } | null>(null);
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null);
  const emptyImg = useRef<HTMLImageElement | null>(null);

  // Create a 1x1 transparent image to hide native drag ghost
  useEffect(() => {
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    emptyImg.current = img;
  }, []);

  // Mutations
  const starMutation = useStarDriveFile();
  const updateMutation = useUpdateDriveFile();
  const deleteMutation = useDeleteDriveFile();
  const moveMutation = useMoveDriveFile();
  const createFolderMutation = useCreateDriveFolder();
  const updateFolderMutation = useUpdateDriveFolder();
  const deleteFolderMutation = useDeleteDriveFolder();
  const restoreFileMutation = useRestoreDriveFile();
  const restoreFolderMutation = useRestoreDriveFolder();
  const permanentDeleteFileMutation = usePermanentDeleteDriveFile();
  const permanentDeleteFolderMutation = usePermanentDeleteDriveFolder();
  const emptyTrashMutation = useEmptyDriveTrash();

  const isTrashView = sidebarView === 'trash';
  const { data: trashData } = useDriveTrash();

  // Sync folder from URL
  useEffect(() => {
    setCurrentFolderId(initialFolderId || null);
  }, [initialFolderId]);

  // Page-level drag-and-drop
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounter = useRef(0);
  const createFileMutation = useCreateDriveFile();
  const { uploadFile } = useFileUpload({ folder: 'drive' });

  const handlePageDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  }, []);

  const handlePageDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDraggingOver(false);
    }
  }, []);

  const handlePageDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const guessFileType = (mimeType: string) => {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return 'spreadsheet';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';
    if (mimeType.includes('document') || mimeType.includes('word')) return 'document';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar')) return 'archive';
    return 'file';
  };

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    toast.info(t.welddrive.toasts.uploading.replace('{count}', String(files.length)).replace('{plural}', files.length > 1 ? 's' : ''));

    for (const file of files) {
      try {
        const result = await uploadFile(file);
        if (result) {
          await createFileMutation.mutateAsync({
            fileName: result.fileName || file.name,
            originalName: file.name,
            mimeType: result.mimeType || file.type,
            fileSize: result.fileSize || file.size,
            fileType: guessFileType(file.type),
            storagePath: result.fileKey || '',
            fileKey: result.fileKey,
            url: result.url,
            folderId: currentFolderId || undefined,
          });
        }
      } catch {
        toast.error(t.welddrive.toasts.uploadFailed.replace('{name}', file.name));
      }
    }
    toast.success(t.welddrive.toasts.uploadSuccess.replace('{count}', String(files.length)).replace('{plural}', files.length > 1 ? 's' : ''));
  }, [uploadFile, createFileMutation, currentFolderId]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFolderUploadClick = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    void uploadFiles(files);
  }, [uploadFiles]);

  const handlePageDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDraggingOver(false);

    // Internal file drag â€” move to root (out of folder)
    const fileId = e.dataTransfer.getData('application/x-drive-file-id');
    if (fileId) {
      moveMutation.mutate({ id: fileId, folderId: null }, {
        onSuccess: () => toast.success(t.welddrive.toasts.movedToMyDrive),
        onError: () => toast.error(t.welddrive.toasts.failedToMoveFile),
      });
      return;
    }

    await uploadFiles(Array.from(e.dataTransfer.files));
  }, [uploadFiles, moveMutation]);

  // Listen for create-folder event from sidebar
  useEffect(() => {
    const handler = () => setShowCreateFolder(true);
    window.addEventListener('welddrive:create-folder', handler);
    return () => window.removeEventListener('welddrive:create-folder', handler);
  }, []);

  // Determine which data source to use based on view
  const useAggregated = sidebarView === 'all-files' || sidebarView === 'recent' || !!activeSourceFilter;
  const showFolders = sidebarView === 'my-drive' && !activeSourceFilter;

  // Build query params for the active view
  const buildParams = useCallback((): DriveFilesParams => {
    const params: DriveFilesParams = {
      page,
      pageSize: 50,
      sortBy,
      sortOrder,
    };
    if (activeTypeFilter) params.type = activeTypeFilter;
    if (activeSourceFilter && activeSourceFilter !== 'all') params.source = activeSourceFilter;

    // Recent: sort by date, last 30 days
    if (sidebarView === 'recent') {
      params.sortBy = 'createdAt';
      params.sortOrder = 'desc';
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      params.dateFrom = thirtyDaysAgo.toISOString();
    }

    return params;
  }, [page, sortBy, sortOrder, activeTypeFilter, activeSourceFilter, sidebarView, showFolders]);

  const allFilesQuery = useAllFiles(useAggregated ? buildParams() : undefined);
  const driveFilesQuery = useDriveFiles(!useAggregated ? buildParams() : undefined);
  const foldersQuery = useDriveFolders(showFolders ? currentFolderId : undefined);
  const allFoldersQuery = useAllDriveFolders();
  const allFolders = allFoldersQuery.data?.data || [];

  const activeQuery = useAggregated ? allFilesQuery : driveFilesQuery;
  const rawFiles = activeQuery.data?.data || [];
  const nonTrashFolders = (showFolders ? foldersQuery.data?.data : []) || [];
  const folders = isTrashView ? (trashData?.folders || []) : nonTrashFolders;
  const isLoading = isTrashView ? false : activeQuery.isLoading;

  // Apply client-side view filters
  const files = useMemo(() => {
    let result = rawFiles;

    if (sidebarView === 'starred') {
      result = result.filter(f => f.isStarred);
    }

    if (sidebarView === 'uploads') {
      // Show only drive-source files (user uploads), sorted newest first
      result = result.filter(f => f.source === 'drive');
      result = [...result].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    if (sidebarView === 'shared') {
      // Placeholder: show files that are not uploaded by current user
      // When sharing API is implemented, this will filter by shared status
      result = result.filter(f => f.uploadedById !== null);
    }

    if (sidebarView === 'trash') {
      // Map DriveFile â†’ UnifiedFile shape (field names differ)
      return (trashData?.files || []).map((f): UnifiedFile => ({
        id: f.id,
        name: f.fileName,
        fileType: (f.fileType || 'file') as any,
        mimeType: f.mimeType,
        fileSize: f.fileSize,
        url: f.url,
        thumbnailUrl: f.thumbnailUrl,
        source: 'drive',
        sourceLabel: 'Drive',
        navigateTo: null,
        folderId: f.folderId,
        isStarred: f.isStarred,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        uploadedById: f.uploadedById,
        deletedAt: f.deletedAt,
      }));
    }

    return result;
  }, [rawFiles, sidebarView, trashData]);

  const items = useMemo(() => {
    if (showFolders && allFolders.length > 0) {
      return buildTreeItems(allFolders, files, expandedFolders, currentFolderId);
    }
    return toItems(folders, files);
  }, [folders, files, allFolders, expandedFolders, showFolders, currentFolderId]);

  const handleFolderOpen = (folderId: string) => {
    setCurrentFolderId(folderId);
    clearSelection();
    setPage(1);
  };

  const handleNavigateUp = () => {
    setCurrentFolderId(null);
    clearSelection();
    setPage(1);
  };

  // Open a native document inline (full-screen route), replacing the old
  // external-app launch.
  const openDocument = useCallback(
    (id: string) => navigate({ to: '/documents/$fileId', params: { fileId: id } }),
    [navigate],
  );

  // Create a standalone drive document and open it inline.
  const handleCreateDocument = useCallback(async () => {
    try {
      const id = await createDocument({
        name: t.welddrive.page.untitledDocument,
        folderId: currentFolderId,
      });
      navigate({ to: '/documents/$fileId', params: { fileId: id } });
    } catch {
      toast.error(t.welddrive.toasts.failedToCreateDocument);
    }
  }, [currentFolderId, navigate, t]);

  const handleFileClick = (file: UnifiedFile) => {
    if (file.isWeldDoc) {
      openDocument(file.id);
    } else if (file.navigateTo) {
      navigate({ to: file.navigateTo });
    } else if (file.fileType === 'document') {
      // Native or uploaded documents (no module-specific route) open in the
      // inline editor; the DOCX load fallback imports uploaded .docx on open.
      openDocument(file.id);
    } else {
      setPreviewFile(file);
    }
  };

  const toggleFolderExpanded = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const sortedItemsRef = useRef<DriveItem[]>([]);

  const handleItemClick = useCallback((item: DriveItem, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Toggle individual item
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
      lastSelectedIdRef.current = item.id;
    } else if (e.shiftKey && lastSelectedIdRef.current) {
      // Range select
      const list = sortedItemsRef.current;
      const lastIdx = list.findIndex(i => i.id === lastSelectedIdRef.current);
      const curIdx = list.findIndex(i => i.id === item.id);
      if (lastIdx >= 0 && curIdx >= 0) {
        const start = Math.min(lastIdx, curIdx);
        const end = Math.max(lastIdx, curIdx);
        const rangeIds = list.slice(start, end + 1).map(i => i.id);
        setSelectedIds(prev => {
          const next = new Set(prev);
          rangeIds.forEach(id => next.add(id));
          return next;
        });
      }
    } else {
      // Simple click â€” select only this item
      setSelectedIds(new Set([item.id]));
      lastSelectedIdRef.current = item.id;
    }
  }, []);

  const handleItemDoubleClick = useCallback((item: DriveItem) => {
    if (item.kind === 'folder' && item._folder) {
      toggleFolderExpanded(item._folder.id);
    } else if (item._file) {
      handleFileClick(item._file);
    }
  }, [toggleFolderExpanded]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'fileType',
      label: t.welddrive.page.filters.type,
      options: [
        { value: 'image', label: t.welddrive.page.filters.fileTypes.images },
        { value: 'video', label: t.welddrive.page.filters.fileTypes.videos },
        { value: 'audio', label: t.welddrive.page.filters.fileTypes.audio },
        { value: 'pdf', label: t.welddrive.page.filters.fileTypes.pdfs },
        { value: 'document', label: t.welddrive.page.filters.fileTypes.documents },
        { value: 'rich-document', label: t.welddrive.page.filters.fileTypes.richDocuments },
        { value: 'spreadsheet', label: t.welddrive.page.filters.fileTypes.spreadsheets },
        { value: 'presentation', label: t.welddrive.page.filters.fileTypes.presentations },
        { value: 'recording', label: t.welddrive.page.filters.fileTypes.recordings },
        { value: 'whiteboard', label: t.welddrive.page.filters.fileTypes.whiteboards },
        { value: 'archive', label: t.welddrive.page.filters.fileTypes.archives },
        { value: 'code', label: t.welddrive.page.filters.fileTypes.code },
        { value: 'folder', label: t.welddrive.page.filters.fileTypes.folders },
        { value: 'file', label: t.welddrive.page.filters.fileTypes.other },
      ],
    },
    {
      field: 'source',
      label: t.welddrive.page.filters.source,
      options: [
        { value: 'drive', label: t.welddrive.page.filters.sources.myDrive },
        { value: 'projects', label: t.welddrive.page.filters.sources.projects },
        { value: 'documents', label: t.welddrive.page.filters.sources.documents },
        { value: 'whiteboards', label: t.welddrive.page.filters.sources.whiteboards },
        { value: 'mail', label: t.welddrive.page.filters.sources.mail },
        { value: 'voip', label: t.welddrive.page.filters.sources.voip },
        { value: 'meetings', label: t.welddrive.page.filters.sources.meetings },
        { value: 'social', label: t.welddrive.page.filters.sources.social },
      ],
    },
    {
      field: 'kind',
      label: t.welddrive.page.filters.kind,
      options: [
        { value: 'file', label: t.welddrive.page.filters.kinds.files },
        { value: 'folder', label: t.welddrive.page.filters.kinds.folders },
      ],
    },
    {
      field: 'isStarred',
      label: t.welddrive.page.filters.starred,
      filterType: 'boolean' as const,
      options: [
        { value: 'true', label: t.welddrive.page.filters.starredOptions.starred },
        { value: 'false', label: t.welddrive.page.filters.starredOptions.notStarred },
      ],
    },
    {
      field: 'name',
      label: t.welddrive.page.filters.name,
      filterType: 'text' as const,
      options: [],
    },
    {
      field: 'fileSize',
      label: t.welddrive.page.filters.size,
      options: [
        { value: 'small', label: t.welddrive.page.filters.sizes.small },
        { value: 'medium', label: t.welddrive.page.filters.sizes.medium },
        { value: 'large', label: t.welddrive.page.filters.sizes.large },
        { value: 'huge', label: t.welddrive.page.filters.sizes.huge },
      ],
    },
  ], [t]);

  const applyFilters = useCallback((allItems: DriveItem[], activeFilters: ActiveFilter[]) => {
    let result = allItems;
    activeFilters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'fileType') {
        result = filter.operator === 'is'
          ? result.filter(i => i.fileType === filter.value)
          : result.filter(i => i.fileType !== filter.value);
      } else if (filter.field === 'source') {
        result = filter.operator === 'is'
          ? result.filter(i => i.source === filter.value)
          : result.filter(i => i.source !== filter.value);
      } else if (filter.field === 'kind') {
        result = filter.operator === 'is'
          ? result.filter(i => i.kind === filter.value)
          : result.filter(i => i.kind !== filter.value);
      } else if (filter.field === 'isStarred') {
        const starred = filter.value === 'true';
        result = filter.operator === 'is'
          ? result.filter(i => i.isStarred === starred)
          : result.filter(i => i.isStarred !== starred);
      } else if (filter.field === 'name') {
        const val = filter.value.toLowerCase();
        if (filter.operator === 'contains') {
          result = result.filter(i => i.name.toLowerCase().includes(val));
        } else if (filter.operator === 'not contains') {
          result = result.filter(i => !i.name.toLowerCase().includes(val));
        } else if (filter.operator === 'is') {
          result = result.filter(i => i.name.toLowerCase() === val);
        } else if (filter.operator === 'is not') {
          result = result.filter(i => i.name.toLowerCase() !== val);
        }
      } else if (filter.field === 'fileSize') {
        const MB = 1024 * 1024;
        const matchSize = (size: number, val: string) => {
          switch (val) {
            case 'small': return size < MB;
            case 'medium': return size >= MB && size < 10 * MB;
            case 'large': return size >= 10 * MB && size < 100 * MB;
            case 'huge': return size >= 100 * MB;
            default: return true;
          }
        };
        if (filter.operator === 'is') {
          result = result.filter(i => matchSize(i.fileSize ?? 0, filter.value));
        } else if (filter.operator === 'is not') {
          result = result.filter(i => !matchSize(i.fileSize ?? 0, filter.value));
        }
      }
    });
    return result;
  }, []);

  const handleSort = useCallback((columnId: string) => {
    setSortState(prev => {
      if (prev?.columnId === columnId) {
        if (prev.direction === 'asc') return { columnId, direction: 'desc' as const };
        return null;
      }
      return { columnId, direction: 'asc' as const };
    });
  }, []);

  const sortedItems = useMemo(() => {
    if (!sortState) return items;
    const { columnId, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      switch (columnId) {
        case 'name':
          return a.name.localeCompare(b.name) * dir;
        case 'fileType':
          return a.fileType.localeCompare(b.fileType) * dir;
        case 'source':
          return a.source.localeCompare(b.source) * dir;
        case 'fileSize':
          return ((a.fileSize ?? 0) - (b.fileSize ?? 0)) * dir;
        case 'createdAt':
          return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir;
        default:
          return 0;
      }
    });
  }, [items, sortState]);
  sortedItemsRef.current = sortedItems;

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.welddrive.page.columns.name, width: 'min-w-[200px] flex-1', sortable: true },
    { id: 'fileType', header: t.welddrive.page.columns.type, width: 'w-[120px]', sortable: true },
    { id: 'source', header: t.welddrive.page.columns.source, width: 'w-[140px]', sortable: true },
    { id: 'fileSize', header: t.welddrive.page.columns.size, width: 'w-[100px]', sortable: true },
    { id: 'createdAt', header: t.welddrive.page.columns.modified, width: 'w-[130px]', sortable: true },
  ], [t]);

  // View toggle (same pattern as My Tasks list/pipeline toggle)
  const viewToggle = (
    <div className="flex items-center gap-1">
      {currentFolderId && (
        <Button
          variant="outline"
          className="h-8 text-sm px-3 shadow-none text-muted-foreground mr-1"
          onClick={handleNavigateUp}
        >
          <ChevronLeft className="h-4 w-4 -ml-0.5 mr-0.5" />
          {t.welddrive.toolbar.back}
        </Button>
      )}
      <div className="flex items-center border bg-background dark:bg-input/30 dark:border-input rounded-md overflow-hidden shadow-none">
        <Button
          variant="ghost"
          onClick={() => setViewMode('list')}
          className={cn(
            "h-[30px] w-8 flex items-center justify-center transition-colors",
            viewMode === 'list'
              ? "bg-accent text-accent-foreground dark:bg-input/50"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50"
          )}
          title={t.welddrive.page.listView}
        >
          <List className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          onClick={() => setViewMode('grid')}
          className={cn(
            "h-[30px] w-8 flex items-center justify-center transition-colors",
            viewMode === 'grid'
              ? "bg-accent text-accent-foreground dark:bg-input/50"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50"
          )}
          title={t.welddrive.page.gridView}
        >
          <LayoutGrid className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  // File action handlers for preview modal
  const handleToggleStar = useCallback((file: UnifiedFile) => {
    if (file.source !== 'drive') {
      toast.error(t.welddrive.toasts.onlyDriveFilesStarred);
      return;
    }
    starMutation.mutate(file.id, {
      onSuccess: () => toast.success(file.isStarred ? t.welddrive.toasts.unstarred : t.welddrive.toasts.starToggled),
      onError: () => toast.error(t.welddrive.toasts.failedToUpdateStar),
    });
  }, [starMutation, t]);

  const handleRename = useCallback((file: UnifiedFile) => {
    if (file.source !== 'drive') {
      toast.error(t.welddrive.toasts.onlyDriveFilesRenamed);
      return;
    }
    setRenameFile(file);
  }, [t]);

  const handleRenameSubmit = useCallback((newName: string) => {
    if (!renameFile) return;
    updateMutation.mutate({ id: renameFile.id, fileName: newName }, {
      onSuccess: () => {
        toast.success(t.welddrive.toasts.fileRenamed);
        setRenameFile(null);
      },
      onError: () => toast.error(t.welddrive.toasts.failedToRenameFile),
    });
  }, [renameFile, updateMutation]);

  const handleMoveToFolder = useCallback((file: UnifiedFile) => {
    if (file.source !== 'drive') {
      toast.error(t.welddrive.toasts.onlyDriveFilesMoved);
      return;
    }
    setMoveFile(file);
  }, [t]);

  const handleCopyLink = useCallback((file: UnifiedFile) => {
    if (file.url) {
      navigator.clipboard.writeText(file.url).then(
        () => toast.success(t.welddrive.toasts.linkCopied),
        () => toast.error(t.welddrive.toasts.failedToCopyLink),
      );
    }
  }, [t]);

  const handleDeleteFile = useCallback((file: UnifiedFile) => {
    if (file.source !== 'drive') {
      toast.error(t.welddrive.toasts.onlyDriveFilesDeleted);
      return;
    }
    setDeleteFile(file);
  }, [t]);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteFile) return;
    deleteMutation.mutate(deleteFile.id, {
      onSuccess: () => {
        toast.success(t.welddrive.toasts.movedToTrash);
        setDeleteFile(null);
        setPreviewFile(null);
      },
      onError: () => toast.error(t.welddrive.toasts.failedToMoveToTrash),
    });
  }, [deleteFile, deleteMutation]);

  const handleDuplicateFolder = useCallback((folder: DriveFolder) => {
    createFolderMutation.mutate(
      { name: t.welddrive.folderActions.copyNameSuffix.replace('{name}', folder.name), parentId: folder.parentId || undefined, color: folder.color || undefined },
      {
        onSuccess: () => toast.success(t.welddrive.toasts.folderDuplicated),
        onError: () => toast.error(t.welddrive.toasts.failedToDuplicateFolder),
      }
    );
  }, [createFolderMutation]);

  // Render row for list view
  const renderRow = useCallback((item: DriveItem) => {
    // Empty folder placeholder
    if (item.fileType === '_empty') {
      const indent = item.depth * 24;
      return (
        <div
          key={item.id}
          className="flex items-center px-4 border-b border-gray-200/70 dark:border-border"
          style={{ paddingLeft: `${indent + 16 + 24}px`, height: '51px' }}
        >
          <span className="text-[13px] text-muted-foreground">{t.welddrive.page.emptyState.thisFolderIsEmpty}</span>
        </div>
      );
    }

    const typeConfig = fileTypeIcons[item.fileType] || fileTypeIcons.file;
    const isFolder = item.kind === 'folder';
    const isExpanded = isFolder && item._folder ? expandedFolders.has(item._folder.id) : false;
    const hasChildren = isFolder && item._folder
      ? allFolders.some(f => f.parentId === item._folder!.id) || files.some(f => f.folderId === item._folder!.id)
      : false;
    const FolderIcon = isExpanded ? FolderOpen : Folder;
    const FileIcon = isFolder ? FolderIcon : (typeConfig.icon);
    const badgeClass = sourceBadgeStyles[item.source] || sourceBadgeStyles.drive;
    const indent = item.depth * 24;

    const isDragOver = isFolder && item._folder && dragOverFolderId === item._folder.id;
    const isBeingDragged = !isFolder && item._file && draggingFileId === item._file.id;

    const isSelected = selectedIds.has(item.id);

    return (
      <div
        key={item.id}
        onClick={(e) => handleItemClick(item, e)}
        onDoubleClick={() => handleItemDoubleClick(item)}
        draggable={!isFolder && item._file?.source === 'drive'}
        onDragStart={(e) => {
          if (!isFolder && item._file) {
            e.dataTransfer.setData('application/x-drive-file-id', item._file.id);
            e.dataTransfer.effectAllowed = 'move';

            // Hide native drag ghost
            if (emptyImg.current) {
              e.dataTransfer.setDragImage(emptyImg.current, 0, 0);
            }

            // Get icon HTML from the row
            const row = e.currentTarget as HTMLElement;
            const iconEl = row.querySelector('[data-drag-handle] svg:not([data-drag-exclude])');
            const iconHtml = iconEl ? iconEl.outerHTML : '';
            setDragGhost({ name: item.name, iconHtml, x: e.clientX, y: e.clientY });
            setDraggingFileId(item._file.id);
          }
        }}
        onDrag={(e) => {
          if (e.clientX > 0 || e.clientY > 0) {
            setDragGhost(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
          }
        }}
        onDragEnd={() => {
          setDragGhost(null);
          setDraggingFileId(null);
        }}
        onDragOver={(e) => {
          if (isFolder && item._folder) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            setDragOverFolderId(item._folder.id);
          }
        }}
        onDragLeave={(e) => {
          if (isFolder && item._folder) {
            e.stopPropagation();
            setDragOverFolderId(null);
          }
        }}
        onDrop={(e) => {
          if (isFolder && item._folder) {
            e.preventDefault();
            e.stopPropagation();
            setDragOverFolderId(null);
            const fileId = e.dataTransfer.getData('application/x-drive-file-id');
            if (fileId) {
              moveMutation.mutate({ id: fileId, folderId: item._folder.id }, {
                onSuccess: () => toast.success(t.welddrive.toasts.movedToFolder.replace('{folderName}', item._folder!.name)),
                onError: () => toast.error(t.welddrive.toasts.failedToMoveFile),
              });
            }
          }
        }}
        className={cn(
          'flex items-center gap-4 px-4 cursor-pointer border-b border-gray-200/70 dark:border-border group transition-all duration-200',
          isDragOver
            ? 'bg-primary/10 border-primary/30'
            : isSelected
              ? 'bg-primary/8 dark:bg-primary/15'
              : 'hover:bg-gray-50 dark:hover:bg-secondary/50',
          isBeingDragged && 'opacity-40 bg-muted/30',
        )}
        style={{ height: '51px' }}
      >
        {/* Name */}
        <div data-drag-handle className="min-w-[200px] flex-1 flex items-center gap-1.5" style={{ paddingLeft: `${indent}px` }}>
          {isFolder && (
            <ChevronRight
              data-drag-exclude
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                isExpanded && 'rotate-90',
              )}
            />
          )}
          <FileIcon className={cn('h-4 w-4 shrink-0', isFolder ? 'text-blue-500' : typeConfig.color)} />
          <span className="text-sm font-medium truncate text-gray-900 dark:text-foreground">
            {item.name}
          </span>
          {item.isStarred && (
            <Star data-drag-exclude className="h-3.5 w-3.5 text-yellow-400 fill-yellow-400 shrink-0" />
          )}
        </div>

        {/* Type */}
        <div className="w-[120px]">
          <span className="text-sm text-muted-foreground capitalize">{item.fileType}</span>
        </div>

        {/* Source */}
        <div className="w-[140px]">
          {item.kind === 'file' && (
            <span className={cn('-translate-y-[1.5px]', driveLabelClass, badgeClass)}>
              {item.sourceLabel}
            </span>
          )}
        </div>

        {/* Size */}
        <div className="w-[100px]">
          <span className="text-sm font-mono text-muted-foreground tabular-nums">
            {item.fileSize ? formatFileSize(item.fileSize) : 'â€”'}
          </span>
        </div>

        {/* Modified / Auto-delete countdown */}
        <div className="w-[130px]">
          {isTrashView && item._file?.deletedAt ? (() => {
            const daysLeft = Math.max(0, 30 - Math.floor((Date.now() - new Date(item._file!.deletedAt!).getTime()) / 86400000));
            return <span className="text-sm font-mono text-orange-500">{daysLeft === 0 ? t.welddrive.page.trash.deletingSoon : t.welddrive.page.trash.deletesIn.replace('{days}', String(daysLeft))}</span>;
          })() : (
            <span className="text-sm font-mono text-muted-foreground">{formatDate(item.createdAt)}</span>
          )}
        </div>

        {/* Actions */}
        <div className="w-[40px] flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="p-1 rounded-md hover:bg-muted">
                  <MoreVertical className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              {isTrashView ? (
                <DropdownMenuContent align="end" className="w-48" sideOffset={4}>
                  <DropdownMenuItem onClick={() => {
                    if (item.kind === 'file' && item._file) {
                      restoreFileMutation.mutate(item._file.id, {
                        onSuccess: () => toast.success(t.welddrive.toasts.fileRestored),
                        onError: () => toast.error(t.welddrive.toasts.failedToRestoreFile),
                      });
                    } else if (item.kind === 'folder' && item._folder) {
                      restoreFolderMutation.mutate(item._folder.id, {
                        onSuccess: () => toast.success(t.welddrive.toasts.folderRestored),
                        onError: () => toast.error(t.welddrive.toasts.failedToRestoreFolder),
                      });
                    }
                  }}>
                    <RotateCcw className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.restore}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
                    onClick={() => {
                      if (item.kind === 'file' && item._file) {
                        permanentDeleteFileMutation.mutate(item._file.id, {
                          onSuccess: () => toast.success(t.welddrive.toasts.filePermanentlyDeleted),
                          onError: () => toast.error(t.welddrive.toasts.failedToDeleteFile),
                        });
                      } else if (item.kind === 'folder' && item._folder) {
                        permanentDeleteFolderMutation.mutate(item._folder.id, {
                          onSuccess: () => toast.success(t.welddrive.toasts.folderPermanentlyDeleted),
                          onError: () => toast.error(t.welddrive.toasts.failedToDeleteFolder),
                        });
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                    {t.welddrive.page.actions.deletePermanently}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              ) : item.kind === 'file' && item._file ? (
                <DropdownMenuContent align="end" className="w-52" sideOffset={4}>
                  {item._file.isWeldDoc && (
                    <DropdownMenuItem onClick={() => openDocument(item._file!.id)}>
                      <FileText className="h-4 w-4 mr-0.5" />
                      {t.welddrive.page.actions.openInWeldDocs}
                    </DropdownMenuItem>
                  )}
                  {!item._file.isWeldDoc && item._file.url && (
                    <DropdownMenuItem asChild>
                      <a href={item._file.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4 mr-0.5" />
                        {t.welddrive.page.actions.openInNewTab}
                      </a>
                    </DropdownMenuItem>
                  )}
                  {!item._file.isWeldDoc && (item._file.source === 'drive' || item._file.url) && (
                    <DropdownMenuItem onClick={() => downloadFile(item._file!)}>
                      <Download className="h-4 w-4 mr-0.5" />
                      {t.welddrive.page.actions.download}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setDetailFile(item._file!)}>
                    <Info className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.details}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleToggleStar(item._file!)}>
                    <Star className={cn("h-4 w-4 mr-0.5", item.isStarred && "fill-yellow-400 text-yellow-400")} />
                    {item.isStarred ? t.welddrive.page.actions.removeFromStarred : t.welddrive.page.actions.addToStarred}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleRename(item._file!)}>
                    <Pencil className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleMoveToFolder(item._file!)}>
                    <FolderInput className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.moveToFolder}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleCopyLink(item._file!)}>
                    <Link className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.copyLink}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
                    onClick={() => handleDeleteFile(item._file!)}
                  >
                    <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                    {t.welddrive.page.actions.moveToTrash}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              ) : item.kind === 'folder' && item._folder ? (
                <DropdownMenuContent align="end" className="w-48" sideOffset={4}>
                  <DropdownMenuItem onClick={() => setRenameFolder(item._folder!)}>
                    <Pencil className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleDuplicateFolder(item._folder!)}>
                    <Copy className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.duplicate}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
                    onClick={() => setDeleteFolder(item._folder!)}
                  >
                    <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                    {t.welddrive.page.actions.moveToTrash}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              ) : null}
            </DropdownMenu>
          </div>
        </div>
      </div>
    );
  }, [handleItemClick, handleItemDoubleClick, selectedIds, handleToggleStar, handleRename, handleMoveToFolder, handleCopyLink, handleDeleteFile, handleDuplicateFolder, expandedFolders, allFolders, files, dragOverFolderId, moveMutation, isTrashView, restoreFileMutation, restoreFolderMutation, permanentDeleteFileMutation, permanentDeleteFolderMutation, t]);

  // Google-Drive-style "New" menu: a single primary button that opens a
  // dropdown with create + upload actions. Reused by both the list (EntityList)
  // and grid views so the entry point is identical everywhere.
  const newMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          className="h-8 bg-primary text-primary-foreground hover:bg-primary/90"
          data-testid="welddrive-new-btn"
        >
          <Plus className="h-4 w-4 md:mr-0.5" />
          <span className="hidden md:inline">{t.welddrive.page.newButton}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {showFolders && (
          <>
            <DropdownMenuItem onClick={() => setShowCreateFolder(true)} data-testid="welddrive-new-folder-btn">
              <FolderPlus className="h-4 w-4 mr-0.5" />
              {t.welddrive.page.newFolder}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={handleUploadClick} data-testid="welddrive-file-upload-btn">
          <FileUp className="h-4 w-4 mr-0.5" />
          {t.welddrive.page.fileUpload}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleFolderUploadClick} data-testid="welddrive-folder-upload-btn">
          <FolderUp className="h-4 w-4 mr-0.5" />
          {t.welddrive.page.folderUpload}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCreateDocument} data-testid="welddrive-new-doc-btn">
          <FileText className="h-4 w-4 mr-0.5 text-blue-500" />
          {t.welddrive.page.newDocument}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const actionButtons = isTrashView ? (
    <Button
      variant="outline"
      className="hidden md:flex h-8 text-sm px-3 shadow-none text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
      onClick={() => {
        if (confirm(t.welddrive.page.trash.confirmEmptyTitle)) {
          emptyTrashMutation.mutate(undefined, {
            onSuccess: () => toast.success(t.welddrive.toasts.trashEmptied),
            onError: () => toast.error(t.welddrive.toasts.failedToEmptyTrash),
          });
        }
      }}
    >
      <Trash2 className="h-4 w-4 mr-1" />
      {t.welddrive.page.emptyTrash}
    </Button>
  ) : (
    newMenu
  );

  // Resolve selected items to their underlying files (for the action bar)
  const selectedFiles = useMemo(() => {
    if (selectedIds.size === 0) return [];
    return sortedItems
      .filter(i => selectedIds.has(i.id) && i.kind === 'file' && i._file)
      .map(i => i._file!);
  }, [selectedIds, sortedItems]);

  const selectedFolders = useMemo(() => {
    if (selectedIds.size === 0) return [];
    return sortedItems
      .filter(i => selectedIds.has(i.id) && i.kind === 'folder' && i._folder)
      .map(i => i._folder!);
  }, [selectedIds, sortedItems]);

  const handleBulkDelete = useCallback(() => {
    const driveFiles = selectedFiles.filter(f => f.source === 'drive');
    const driveFolders = selectedFolders;
    if (driveFiles.length === 0 && driveFolders.length === 0) {
      toast.error(t.welddrive.toasts.onlyDriveItemsDeleted);
      return;
    }
    const count = driveFiles.length + driveFolders.length;
    driveFiles.forEach(f => deleteMutation.mutate(f.id));
    driveFolders.forEach(f => deleteFolderMutation.mutate(f.id));
    toast.success(t.welddrive.toasts.itemsMovedToTrash.replace('{count}', String(count)).replace('{plural}', count > 1 ? 's' : ''));
    clearSelection();
  }, [selectedFiles, selectedFolders, deleteMutation, deleteFolderMutation, clearSelection, t]);

  const handleBulkStar = useCallback(() => {
    const driveFiles = selectedFiles.filter(f => f.source === 'drive');
    driveFiles.forEach(f => starMutation.mutate(f.id));
    toast.success(t.welddrive.toasts.filesStarred.replace('{count}', String(driveFiles.length)).replace('{plural}', driveFiles.length > 1 ? 's' : ''));
  }, [selectedFiles, starMutation, t]);

  const handleBulkDownload = useCallback(() => {
    const downloadable = selectedFiles.filter(f => f.source === 'drive' || f.url);
    const skipped = selectedFiles.length - downloadable.length;
    if (downloadable.length === 0) {
      toast.error(t.welddrive.toasts.noDownloadUrl);
      return;
    }
    if (skipped > 0) {
      toast.warning(t.welddrive.toasts.someFilesNoUrl.replace('{count}', String(skipped)));
    }
    downloadable.forEach(f => { void downloadFile(f); });
  }, [selectedFiles, t]);

  return (
    <div
      className="flex-1 flex flex-col min-w-0 h-full relative"
      onClick={(e) => { if (e.target === e.currentTarget) clearSelection(); }}
      onDragEnter={handlePageDragEnter}
      onDragLeave={handlePageDragLeave}
      onDragOver={handlePageDragOver}
      onDrop={handlePageDrop}
    >
      {/* Custom drag ghost */}
      {dragGhost && (
        <div
          className="fixed z-[9999] pointer-events-none transition-opacity duration-150"
          style={{ left: `${dragGhost.x}px`, top: `${dragGhost.y}px` }}
        >
          <div
            className="flex items-center gap-1.5 h-[50px] px-4 bg-white border border-[#dadce0] rounded-xl max-w-[320px] animate-in fade-in zoom-in-95 duration-150"
            style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
          >
            <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4" dangerouslySetInnerHTML={{ __html: dragGhost.iconHtml }} />
            <span className="text-sm font-medium text-gray-900 truncate">{dragGhost.name}</span>
          </div>
        </div>
      )}

      {/* Drag overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 bg-primary/5 border-[2.5px] border-dashed border-primary rounded-lg flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-10 w-10" />
            <p className="text-lg font-semibold">{t.welddrive.page.dragAndDrop.dropFilesToUpload}</p>
            <p className="text-sm text-muted-foreground">{t.welddrive.page.dragAndDrop.dropFilesDescription.replace('{destination}', currentFolderId ? t.welddrive.page.dragAndDrop.currentFolder : t.welddrive.page.dragAndDrop.myDrive)}</p>
          </div>
        </div>
      )}
      {viewMode === 'list' ? (
        <EntityList<DriveItem>
          items={sortedItems}
          isLoading={isLoading}
          error={null}
          headerColumns={headerColumns}
          filters={filterConfigs}
          maxFilters={5}
          applyFilters={applyFilters}
          renderRow={renderRow}
          searchPlaceholder={t.welddrive.page.searchPlaceholder}
          searchFields={['name']}
          sortState={sortState}
          onSort={handleSort}
          topBarClassName="pt-2 pb-2"
          stickyOffset={-16}
          leftActionButtons={viewToggle}
          actionButtons={actionButtons}
          emptyState={isTrashView ? {
            icon: (
              <EmptyStateIllustration>
                <Trash className="h-24 w-24 text-[#e0e0e0] dark:text-white/8" strokeWidth={0.5} />
              </EmptyStateIllustration>
            ),
            title: t.welddrive.page.emptyState.trashEmpty,
            description: t.welddrive.page.emptyState.trashEmptyDescription,
          } : sidebarView === 'starred' ? {
            icon: (
              <EmptyStateIllustration>
                <Star className="h-24 w-24 text-[#e0e0e0] dark:text-white/8" strokeWidth={0.5} />
              </EmptyStateIllustration>
            ),
            title: t.welddrive.page.emptyState.noStarredFiles,
            description: t.welddrive.page.emptyState.noStarredDescription,
          } : {
            icon: (
              <EmptyStateIllustration>
                <Folder className="h-24 w-24 text-[#e0e0e0] dark:text-white/8" strokeWidth={0.5} />
              </EmptyStateIllustration>
            ),
            title: t.welddrive.page.emptyState.noFilesYet,
            description: t.welddrive.page.emptyState.noFilesDescription,
            action: {
              label: t.welddrive.page.uploadFiles,
              onClick: handleUploadClick,
            },
          }}
          noResultsState={isTrashView ? {
            title: t.welddrive.page.emptyState.noItemsInTrash,
            description: t.welddrive.page.emptyState.noItemsInTrashDescription,
          } : {
            title: t.welddrive.page.emptyState.noFilesFound,
            description: t.welddrive.page.emptyState.noFilesFoundDescription,
          }}
        />
      ) : (
        <DriveGridView
          folders={folders}
          files={files}
          isLoading={isLoading}
          isAllFiles={!showFolders}
          filterConfigs={filterConfigs}
          viewToggle={viewToggle}
          newMenu={newMenu}
          selectedIds={selectedIds}
          onSelect={(id, e) => {
            if (e.ctrlKey || e.metaKey) {
              setSelectedIds(prev => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              });
            } else {
              setSelectedIds(new Set([id]));
            }
            lastSelectedIdRef.current = id;
          }}
          onClearSelection={clearSelection}
          onFolderOpen={handleFolderOpen}
          onFileClick={handleFileClick}
          onUploadClick={handleUploadClick}
          onToggleStar={handleToggleStar}
          onRename={handleRename}
          onMoveToFolder={handleMoveToFolder}
          onCopyLink={handleCopyLink}
          onDelete={handleDeleteFile}
          onDetails={(file) => setDetailFile(file)}
          onRenameFolder={(f) => setRenameFolder(f)}
          onDuplicateFolder={handleDuplicateFolder}
          onDeleteFolder={(f) => setDeleteFolder(f)}
        />
      )}

      {/* Detail Panel */}
      <FileDetailPanel
        file={detailFile}
        isOpen={!!detailFile}
        onClose={() => setDetailFile(null)}
        onToggleStar={handleToggleStar}
        onRename={handleRename}
        onMoveToFolder={handleMoveToFolder}
        onCopyLink={handleCopyLink}
        onDelete={handleDeleteFile}
        onPreview={(file) => setPreviewFile(file)}
        description={detailFile ? (fileDescriptions[detailFile.id] || '') : ''}
        onDescriptionChange={(desc) => {
          if (!detailFile) return;
          setFileDescriptions(prev => ({ ...prev, [detailFile.id]: desc }));
        }}
        comments={detailFile ? (fileComments[detailFile.id] || []) : []}
        onAddComment={(content) => {
          if (!detailFile) return;
          const newComment = {
            id: Date.now().toString(),
            content,
            authorId: 'current-user',
            authorName: 'You',
            authorAvatar: null,
            createdAt: new Date().toISOString(),
          };
          setFileComments(prev => ({
            ...prev,
            [detailFile.id]: [...(prev[detailFile.id] || []), newComment],
          }));
        }}
        onUpdateComment={(commentId, content) => {
          if (!detailFile) return;
          setFileComments(prev => ({
            ...prev,
            [detailFile.id]: (prev[detailFile.id] || []).map(c =>
              c.id === commentId ? { ...c, content } : c
            ),
          }));
        }}
        onDeleteComment={(commentId) => {
          if (!detailFile) return;
          setFileComments(prev => ({
            ...prev,
            [detailFile.id]: (prev[detailFile.id] || []).filter(c => c.id !== commentId),
          }));
        }}
        currentUserId="current-user"
      />

      {/* Modals */}
      <FilePreviewModal
        file={previewFile}
        open={!!previewFile}
        onClose={() => setPreviewFile(null)}
        onToggleStar={handleToggleStar}
        onRename={handleRename}
        onMoveToFolder={handleMoveToFolder}
        onCopyLink={handleCopyLink}
        onDelete={handleDeleteFile}
      />

      <RenameDialog
        open={!!renameFile}
        onOpenChange={(open) => { if (!open) setRenameFile(null); }}
        currentName={renameFile?.name || ''}
        onRename={handleRenameSubmit}
        title={t.welddrive.confirmDialog.renameFile.title}
      />

      <MoveToFolderDialog
        open={!!moveFile}
        onOpenChange={(open) => { if (!open) setMoveFile(null); }}
        fileName={moveFile?.name || ''}
        currentFolderId={moveFile?.folderId || null}
        onMove={(folderId) => {
          if (!moveFile) return;
          moveMutation.mutate({ id: moveFile.id, folderId }, {
            onSuccess: () => {
              toast.success(t.welddrive.toasts.fileMoved);
              setMoveFile(null);
              setPreviewFile(null);
            },
            onError: () => toast.error(t.welddrive.toasts.failedToMoveFileMutation),
          });
        }}
      />

      <ConfirmDialog
        open={!!deleteFile}
        onOpenChange={(open) => { if (!open) setDeleteFile(null); }}
        title={t.welddrive.confirmDialog.moveToTrash.title}
        description={t.welddrive.confirmDialog.moveToTrash.description.replace('{name}', deleteFile?.name ?? '')}
        confirmLabel={t.welddrive.confirmDialog.moveToTrash.confirmLabel}
        variant="destructive"
        onConfirm={handleDeleteConfirm}
      />

      <RenameDialog
        open={!!renameFolder}
        onOpenChange={(open) => { if (!open) setRenameFolder(null); }}
        currentName={renameFolder?.name || ''}
        onRename={(newName) => {
          if (!renameFolder) return;
          updateFolderMutation.mutate({ id: renameFolder.id, name: newName }, {
            onSuccess: () => {
              toast.success(t.welddrive.toasts.folderRenamed);
              setRenameFolder(null);
            },
            onError: () => toast.error(t.welddrive.toasts.failedToRenameFolder),
          });
        }}
        title={t.welddrive.confirmDialog.renameFolder.title}
      />

      <ConfirmDialog
        open={!!deleteFolder}
        onOpenChange={(open) => { if (!open) setDeleteFolder(null); }}
        title={t.welddrive.confirmDialog.moveToTrash.title}
        description={t.welddrive.confirmDialog.moveToTrash.description.replace('{name}', deleteFolder?.name ?? '')}
        confirmLabel={t.welddrive.confirmDialog.moveToTrash.confirmLabel}
        variant="destructive"
        onConfirm={() => {
          if (!deleteFolder) return;
          deleteFolderMutation.mutate(deleteFolder.id, {
            onSuccess: () => {
              toast.success(t.welddrive.toasts.movedToTrash);
              setDeleteFolder(null);
            },
            onError: () => toast.error(t.welddrive.toasts.failedToMoveToTrash),
          });
        }}
      />

      <CreateFolderDialog
        open={showCreateFolder}
        onOpenChange={setShowCreateFolder}
        parentId={currentFolderId}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Folder upload — `webkitdirectory` lets the browser pick a whole folder.
          These directory-picker attributes aren't in React's input typings, so
          they're spread via a cast. */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      />

      {/* Selection action bar */}
      {selectedIds.size > 0 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-200">
          <div className="flex items-center gap-1 rounded-xl border border-border bg-background px-2 py-1.5 shadow-lg">
            <span className="text-sm font-medium text-foreground px-2 tabular-nums">
              {t.welddrive.page.selection.selected.replace('{count}', String(selectedIds.size))}
            </span>
            <div className="w-px h-5 bg-border mx-1" />
            {selectedFiles.length === 1 && selectedFolders.length === 0 && (
              <>
                <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground" onClick={() => handleRename(selectedFiles[0])}>
                  <Pencil className="h-4 w-4 mr-0.5" />
                  {t.welddrive.page.selection.rename}
                </Button>
                <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground" onClick={() => setDetailFile(selectedFiles[0])}>
                  <Info className="h-4 w-4 mr-0.5" />
                  {t.welddrive.page.selection.details}
                </Button>
              </>
            )}
            {selectedFiles.length > 0 && selectedFolders.length === 0 && (
              <>
                <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground" onClick={handleBulkDownload}>
                  <Download className="h-4 w-4 mr-0.5" />
                  {t.welddrive.page.selection.download}
                </Button>
                <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground" onClick={handleBulkStar}>
                  <Star className="h-4 w-4 mr-0.5" />
                  {t.welddrive.page.selection.star}
                </Button>
              </>
            )}
            {(selectedFiles.some(f => f.source === 'drive') || selectedFolders.length > 0) && (
              <>
                {selectedFiles.length === 1 && selectedFolders.length === 0 && (
                  <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground" onClick={() => handleMoveToFolder(selectedFiles[0])}>
                    <FolderInput className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.selection.move}
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40" onClick={handleBulkDelete}>
                  <Trash2 className="h-4 w-4 mr-0.5" />
                  {t.welddrive.page.selection.delete}
                </Button>
              </>
            )}
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground" onClick={clearSelection}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Grid view with its own toolbar (same pattern as MyTasksPipeline)
function DriveGridView({
  folders,
  files,
  isLoading,
  isAllFiles,
  filterConfigs,
  viewToggle,
  selectedIds,
  newMenu,
  onSelect,
  onClearSelection,
  onFolderOpen,
  onFileClick,
  onUploadClick,
  onToggleStar,
  onRename,
  onMoveToFolder,
  onCopyLink,
  onDelete,
  onDetails,
  onRenameFolder,
  onDuplicateFolder,
  onDeleteFolder,
}: {
  folders: DriveFolder[];
  files: UnifiedFile[];
  isLoading: boolean;
  isAllFiles: boolean;
  filterConfigs: FilterConfig[];
  viewToggle: React.ReactNode;
  newMenu: React.ReactNode;
  selectedIds: Set<string>;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onClearSelection: () => void;
  onFolderOpen: (folderId: string) => void;
  onFileClick: (file: UnifiedFile) => void;
  onUploadClick: () => void;
  onToggleStar: (file: UnifiedFile) => void;
  onRename: (file: UnifiedFile) => void;
  onMoveToFolder: (file: UnifiedFile) => void;
  onCopyLink: (file: UnifiedFile) => void;
  onDelete: (file: UnifiedFile) => void;
  onDetails: (file: UnifiedFile) => void;
  onRenameFolder?: (folder: DriveFolder) => void;
  onDuplicateFolder?: (folder: DriveFolder) => void;
  onDeleteFolder?: (folder: DriveFolder) => void;
}) {
  const { t } = useI18n();
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  // Filter files based on active filters and search
  const filteredFiles = useMemo(() => {
    let result = files;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(f => f.name.toLowerCase().includes(q));
    }

    activeFilters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'fileType') {
        result = filter.operator === 'is'
          ? result.filter(f => f.fileType === filter.value)
          : result.filter(f => f.fileType !== filter.value);
      } else if (filter.field === 'source') {
        result = filter.operator === 'is'
          ? result.filter(f => f.source === filter.value)
          : result.filter(f => f.source !== filter.value);
      }
    });

    return result;
  }, [files, searchQuery, activeFilters]);

  const filteredFolders = useMemo(() => {
    if (!searchQuery) return folders;
    const q = searchQuery.toLowerCase();
    return folders.filter(f => f.name.toLowerCase().includes(q));
  }, [folders, searchQuery]);

  const isEmpty = filteredFiles.length === 0 && filteredFolders.length === 0;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Toolbar â€” matches EntityList top bar */}
      <div className="flex items-center justify-between px-3 md:px-4 h-[53px] border-b border-border pt-2 pb-2">
        <div className="hidden md:flex items-center gap-2">
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />
          {viewToggle}
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative hidden md:flex items-center">
            <div className={cn(
              "flex items-center transition-all duration-200 ease-out",
              searchOpen ? "w-48" : "w-8"
            )}>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200",
                  searchOpen && "opacity-0 pointer-events-none absolute"
                )}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
              <div className={cn(
                "relative transition-all duration-200 ease-out",
                searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
              )}>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder={t.welddrive.page.searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>

          {newMenu}
        </div>
      </div>

      {/* Grid content */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center gap-2 p-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t.welddrive.page.loading}</span>
        </div>
      ) : isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
          <EmptyStateIllustration>
            <svg width="120" height="140" viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}>
              <rect x="16" y="22" width="80" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
              <rect x="16" y="22" width="80" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
              <path d="M56 62L56 82M46 72L66 72" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="2" strokeLinecap="round" />
              <rect x="30" y="42" width="52" height="8" rx="4" className="fill-gray-100 dark:fill-white/10" />
            </svg>
          </EmptyStateIllustration>
          <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{t.welddrive.page.emptyState.noFilesYet}</h3>
          <p className="text-sm text-muted-foreground mb-5">{t.welddrive.page.emptyState.noFilesDescription}</p>
          <Button size="sm" onClick={onUploadClick}>
            <Plus className="h-4 w-4 mr-0.5" />
            {t.welddrive.page.uploadFiles}
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4" onClick={(e) => { if (e.target === e.currentTarget) onClearSelection(); }}>
          {filteredFolders.length > 0 && (
            <div className="mb-6">
              <p className="text-xs font-medium text-muted-foreground mb-3 px-1">{t.welddrive.page.gridSections.folders}</p>
              <div className="grid grid-cols-[repeat(auto-fill,241px)] gap-4">
                {filteredFolders.map((folder) => (
                  <DriveFolderCard
                    key={folder.id}
                    folder={folder}
                    isSelected={selectedIds.has(`folder-${folder.id}`)}
                    onClick={(e) => onSelect(`folder-${folder.id}`, e)}
                    onDoubleClick={() => onFolderOpen(folder.id)}
                    onRename={onRenameFolder}
                    onDuplicate={onDuplicateFolder}
                    onDelete={onDeleteFolder}
                  />
                ))}
              </div>
            </div>
          )}

          {filteredFiles.length > 0 && (
            <div>
              {filteredFolders.length > 0 && (
                <p className="text-xs font-medium text-muted-foreground mb-3 px-1">{t.welddrive.page.gridSections.files}</p>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,241px)] gap-4">
                {filteredFiles.map((file) => (
                  <DriveFileCard
                    key={`${file.source}-${file.id}`}
                    file={file}
                    isSelected={selectedIds.has(`${file.source}-${file.id}`)}
                    onClick={(e) => onSelect(`${file.source}-${file.id}`, e)}
                    onDoubleClick={() => onFileClick(file)}
                    onToggleStar={onToggleStar}
                    onRename={onRename}
                    onMoveToFolder={onMoveToFolder}
                    onCopyLink={onCopyLink}
                    onDelete={onDelete}
                    onDetails={onDetails}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
