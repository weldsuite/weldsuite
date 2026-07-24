
import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { format, isToday, isYesterday, isThisWeek, isThisMonth, subMonths, isAfter } from "date-fns";
import "./files-table.css";
import { useProjectPermissions } from "@/app/weldflow/contexts/project-permission-context";
import { Button } from "@weldsuite/ui/components/button";
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
import {
  Download,
  EllipsisVertical,
  Trash2,
  FileText,
  File,
  Upload,
  FileImage,
  FileVideo,
  FileAudio,
  FileCode,
  FileArchive,
  Loader2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { filesApi } from "@/app/weldflow/lib/api-client";
import type { FileResponse } from "@/lib/api/legacy-types";
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from "@/components/entity-list";

interface FilesComponentProps {
  projectId: string;
  initialFiles: FileResponse[];
}

const getFileIcon = (contentType: string | undefined | null) => {
  if (!contentType) return File;
  if (contentType.startsWith('image/')) return FileImage;
  if (contentType.startsWith('video/')) return FileVideo;
  if (contentType.startsWith('audio/')) return FileAudio;
  if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('7z')) return FileArchive;
  if (contentType.includes('javascript') || contentType.includes('json') || contentType.includes('xml') || contentType.includes('sql')) return FileCode;
  if (contentType.includes('pdf') || contentType.includes('document') || contentType.includes('word') || contentType.includes('excel') || contentType.includes('powerpoint')) return FileText;
  return File;
};

const getFileType = (contentType: string | undefined | null): string => {
  if (!contentType) return 'other';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('7z')) return 'archive';
  if (contentType.includes('pdf')) return 'pdf';
  if (contentType.includes('document') || contentType.includes('word')) return 'document';
  if (contentType.includes('excel') || contentType.includes('spreadsheet')) return 'spreadsheet';
  return 'other';
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return format(date, 'MMM d, yyyy');
};

// Extended file type with computed properties
interface ExtendedFile extends FileResponse {
  fileType: string;
}

// `/project-files` rows may carry either the legacy `FileResponse` shape
// (contentType/size) or the raw `project_files` row shape (mimeType/fileSize)
// — see the matching note on `filesApi.list` in `app/weldflow/lib/api-client.ts`.
function normalizeFile(raw: Record<string, unknown>): ExtendedFile {
  const contentType = (raw.contentType as string | undefined) ?? (raw.mimeType as string | undefined) ?? '';
  const size = (raw.size as number | undefined) ?? (raw.fileSize as number | undefined) ?? 0;
  return {
    ...raw,
    contentType,
    size,
    fileType: getFileType(contentType),
  } as ExtendedFile;
}

export default function FilesComponent({ projectId, initialFiles }: FilesComponentProps) {
  const { t } = useI18n();
  const { canWrite } = useProjectPermissions();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<ExtendedFile[]>(
    initialFiles.map((f) => normalizeFile(f as unknown as Record<string, unknown>))
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<FileResponse | null>(null);
  const [previewFile, setPreviewFile] = useState<FileResponse | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Close preview on Escape
  useEffect(() => {
    if (!previewFile) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPreviewFile(null); setPreviewUrl(null); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewFile]);

  // Load files
  const loadFiles = useCallback(async () => {
    try {
      const result = await filesApi.list(projectId, {
        page: 1,
        limit: 500,
      });

      if (result.success && result.data) {
        const rows: Record<string, unknown>[] = Array.isArray(result.data) ? result.data : (result.data.items ?? []);
        setFiles(rows.map(normalizeFile));
      }
    } catch (error) {
      console.error('Failed to load files:', error);
    }
  }, [projectId]);

  // Handle file upload using presigned URLs
  const handleFileUpload = async (selectedFiles: FileList | null) => {
    if (!selectedFiles || selectedFiles.length === 0) return;

    setUploading(true);
    const uploadedFiles: string[] = [];

    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        const fileId = `${file.name}-${Date.now()}`;

        try {
          const urlResult = await filesApi.generateUploadUrl(projectId, {
            fileName: file.name,
            contentType: file.type,
            fileSize: file.size,
            folder: 'projects',
          });

          if (!urlResult.success || !urlResult.data) {
            toast.error(t.projects.files.failedToPrepareUpload.replace('{name}', file.name));
            continue;
          }

          const { uploadUrl, fileKey, uploadToken } = urlResult.data;
          setUploadProgress(prev => ({ ...prev, [fileId]: 0 }));

          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const percentComplete = Math.round((e.loaded / e.total) * 100);
              setUploadProgress(prev => ({ ...prev, [fileId]: percentComplete }));
            }
          });

          const uploadPromise = new Promise<string>((resolve, reject) => {
            xhr.addEventListener('load', () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                const etag = xhr.getResponseHeader('ETag');
                resolve(etag || '');
              } else {
                reject(new Error(`Upload failed with status ${xhr.status}`));
              }
            });
            xhr.addEventListener('error', () => reject(new Error('Upload failed')));
            xhr.open('PUT', uploadUrl);
            xhr.setRequestHeader('Content-Type', file.type);
            xhr.send(file);
          });

          const etag = await uploadPromise;

          const confirmResult = await filesApi.confirmUpload(projectId, {
            uploadToken,
            fileKey,
            etag: etag || undefined,
          });

          if (!confirmResult.success) {
            toast.error(t.projects.files.failedToFinalizeUpload.replace('{name}', file.name));
            continue;
          }

          uploadedFiles.push(file.name);
          toast.success(t.projects.files.fileUploadedSuccessfully.replace('{name}', file.name));

          setUploadProgress(prev => {
            const newProgress = { ...prev };
            delete newProgress[fileId];
            return newProgress;
          });
        } catch (error) {
          console.error(`Failed to upload ${file.name}:`, error);
          toast.error(t.projects.files.failedToUpload.replace('{name}', file.name));
          setUploadProgress(prev => {
            const newProgress = { ...prev };
            delete newProgress[fileId];
            return newProgress;
          });
        }
      }

      if (uploadedFiles.length > 0) {
        await loadFiles();
      }
    } catch (error) {
      console.error('Failed to upload files:', error);
      toast.error(t.projects.files.failedToUploadFiles);
    } finally {
      setUploading(false);
      setUploadProgress({});
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const droppedFiles = e.dataTransfer.files;
    await handleFileUpload(droppedFiles);
  };

  // Handle file download
  const handleDownload = useCallback(async (file: FileResponse) => {
    try {
      const result = await filesApi.get(projectId, file.id);
      if (result.success && result.data?.url) {
        window.open(result.data.url, '_blank');
        toast.success(t.projects.files.downloadingFile);
      } else {
        toast.error(result.error || t.projects.files.failedToGetDownloadUrl);
      }
    } catch (error) {
      console.error('Failed to download file:', error);
      toast.error(t.projects.files.failedToDownloadFile);
    }
  }, [projectId, t]);

  // Handle file preview
  const handlePreview = useCallback(async (file: FileResponse) => {
    setPreviewFile(file);
    setPreviewUrl(null);
    setPreviewLoading(true);
    try {
      const result = await filesApi.get(projectId, file.id);
      if (result.success && result.data) {
        setPreviewUrl(result.data.url);
      } else {
        toast.error(t.projects.files.failedToLoadPreview);
        setPreviewFile(null);
      }
    } catch (error) {
      console.error('Failed to load preview:', error);
      toast.error(t.projects.files.failedToLoadPreview);
      setPreviewFile(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [projectId, t]);

  const canPreview = (contentType: string | undefined | null): boolean => {
    if (!contentType) return false;
    return (
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType === 'application/pdf'
    );
  };

  // Handle file delete
  const handleDelete = async () => {
    if (!fileToDelete) return;
    setDeleting(true);

    try {
      const result = await filesApi.delete(projectId, fileToDelete.id);
      if (result.success) {
        toast.success(t.projects.files.fileDeletedSuccessfully);
        setDeleteDialogOpen(false);
        setFileToDelete(null);
        setFiles(prev => prev.filter(f => f.id !== fileToDelete.id));
      } else {
        toast.error(result.error || t.projects.files.failedToDeleteFile);
      }
    } catch (error) {
      console.error('Failed to delete file:', error);
      toast.error(t.projects.files.failedToDeleteFile);
    } finally {
      setDeleting(false);
    }
  };

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'fileType',
      label: t.projects.files.filterType,
      options: [
        { value: 'image', label: t.projects.files.filterImages },
        { value: 'video', label: t.projects.files.filterVideos },
        { value: 'audio', label: t.projects.files.filterAudio },
        { value: 'pdf', label: t.projects.files.filterPdfs },
        { value: 'document', label: t.projects.files.filterDocuments },
        { value: 'spreadsheet', label: t.projects.files.filterSpreadsheets },
        { value: 'archive', label: t.projects.files.filterArchives },
        { value: 'other', label: t.projects.files.filterOther },
      ],
    },
  ], [t]);

  // Group files by upload date
  const groupConfigs: GroupConfig<ExtendedFile>[] = useMemo(() => {
    const now = new Date();
    const oneMonthAgo = subMonths(now, 1);
    const threeMonthsAgo = subMonths(now, 3);

    return [
      {
        id: 'today',
        label: t.projects.files.groupToday,
        filter: (f) => isToday(new Date(f.createdAt)),
        sortOrder: 0,
      },
      {
        id: 'yesterday',
        label: t.projects.files.groupYesterday,
        filter: (f) => isYesterday(new Date(f.createdAt)),
        sortOrder: 1,
      },
      {
        id: 'this-week',
        label: t.projects.files.groupThisWeek,
        filter: (f) => {
          const d = new Date(f.createdAt);
          return isThisWeek(d, { weekStartsOn: 1 }) && !isToday(d) && !isYesterday(d);
        },
        sortOrder: 2,
      },
      {
        id: 'this-month',
        label: t.projects.files.groupThisMonth,
        filter: (f) => {
          const d = new Date(f.createdAt);
          return isThisMonth(d) && !isThisWeek(d, { weekStartsOn: 1 });
        },
        sortOrder: 3,
      },
      {
        id: 'last-month',
        label: t.projects.files.groupLastMonth,
        filter: (f) => {
          const d = new Date(f.createdAt);
          return !isThisMonth(d) && isAfter(d, oneMonthAgo);
        },
        sortOrder: 4,
      },
      {
        id: 'last-3-months',
        label: t.projects.files.groupLast3Months,
        filter: (f) => {
          const d = new Date(f.createdAt);
          return !isAfter(d, oneMonthAgo) && isAfter(d, threeMonthsAgo);
        },
        sortOrder: 5,
      },
      {
        id: 'older',
        label: t.projects.files.groupOlder,
        filter: (f) => !isAfter(new Date(f.createdAt), threeMonthsAgo),
        sortOrder: 6,
      },
    ];
  }, [t]);

  // Apply filters
  const applyFilters = useCallback((items: ExtendedFile[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'fileType') {
        result = filter.operator === 'is'
          ? result.filter(f => f.fileType === filter.value)
          : result.filter(f => f.fileType !== filter.value);
      }
    });
    return result;
  }, []);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.projects.files.columnName, width: 'flex-1 min-w-[250px]' },
    { id: 'size', header: t.projects.files.columnSize, width: 'w-[100px]' },
    { id: 'uploaded', header: t.projects.files.columnUploaded, width: 'w-[120px]' },
  ], [t]);

  // Render row
  const renderRow = useCallback((file: ExtendedFile) => {
    const Icon = getFileIcon(file.contentType);

    return (
      <div
        key={file.id}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
        onClick={() => canPreview(file.contentType) ? handlePreview(file) : handleDownload(file)}
      >
        {/* File Icon & Name */}
        <div className="flex-1 min-w-[250px] flex items-center gap-3">
          <div className="flex-shrink-0 flex items-center justify-center h-9 w-9 rounded-lg bg-gray-100 dark:bg-secondary">
            <Icon className="h-4 w-4 text-gray-500" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-foreground truncate">{file.fileName}</p>
            {file.description && (
              <p className="text-xs text-gray-500 truncate">{file.description}</p>
            )}
          </div>
        </div>

        {/* Size */}
        <div className="w-[100px]">
          <span className="text-sm text-gray-500">{formatFileSize(file.size)}</span>
        </div>

        {/* Uploaded */}
        <div className="w-[120px]">
          <span className="text-sm text-gray-500">{formatDate(file.createdAt)}</span>
        </div>

        {/* Actions */}
        <div className="w-[80px] flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100"
            onClick={() => handleDownload(file)}
          >
            <Download className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => handleDownload(file)}>
                <Download className="h-3.5 w-3.5 mr-2" />
                {t.projects.files.downloadMenuItem}
              </DropdownMenuItem>
              {canWrite && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600"
                    onClick={() => {
                      setFileToDelete(file);
                      setDeleteDialogOpen(true);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    {t.projects.files.deleteMenuItem}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [canWrite, handleDownload, handlePreview, t]);

  return (
    <div
      className="flex flex-col h-full"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary/40 bg-background p-12 shadow-lg flex flex-col items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Upload className="h-6 w-6 text-primary" />
            </div>
            <p className="text-base font-medium">{t.projects.files.dropFilesHere}</p>
            <p className="text-sm text-muted-foreground">{t.projects.files.filesWillBeUploaded}</p>
          </div>
        </div>
      )}

      {/* Upload Progress */}
      {Object.keys(uploadProgress).length > 0 && (
        <div className="border-b">
          <div className="px-4 py-3 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span>{Object.keys(uploadProgress).length > 1
                ? t.projects.files.uploadingFilesPlural.replace('{n}', String(Object.keys(uploadProgress).length))
                : t.projects.files.uploadingFileSingular.replace('{n}', String(Object.keys(uploadProgress).length))
              }</span>
            </div>
            {Object.entries(uploadProgress).map(([fileId, progress]) => (
              <div key={fileId} className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                  <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm truncate max-w-[300px]">{fileId.split('-')[0]}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{progress}%</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFileUpload(e.target.files)}
      />

      <EntityList<ExtendedFile>
        items={files}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={3}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={t.projects.files.searchPlaceholder}
        searchFields={['fileName', 'description']}
        topBarClassName="pt-2 pb-2"
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
        createButton={canWrite ? {
          label: uploading ? t.projects.files.uploadingBtn : t.projects.files.uploadFileBtn,
          onClick: () => fileInputRef.current?.click(),
        } : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Folder fill */}
                <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H96C98.2 34 100 35.8 100 38V92C100 94.2 98.2 96 96 96H24C21.8 96 20 94.2 20 92V30Z" className="fill-white dark:fill-white/[0.03]" />
                {/* Tab highlight */}
                <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H20V30Z" className="fill-gray-50 dark:fill-white/[0.06]" />
                {/* Folder border (on top) */}
                <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H96C98.2 34 100 35.8 100 38V92C100 94.2 98.2 96 96 96H24C21.8 96 20 94.2 20 92V30Z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t.projects.files.noFilesTitle,
          description: canWrite ? t.projects.files.noFilesDescCanWrite : t.projects.files.noFilesDescViewer,
          action: canWrite ? {
            label: t.projects.files.uploadFileBtn,
            onClick: () => fileInputRef.current?.click(),
          } : undefined,
        }}
        noResultsState={{
          title: t.projects.files.noFilesFilterTitle,
          description: t.projects.files.noFilesFilterDesc,
        }}
      />

      {/* File Preview Overlay */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => { setPreviewFile(null); setPreviewUrl(null); }}>
          {/* Header bar */}
          <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 z-10">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg bg-white/10">
                {(() => { const Icon = getFileIcon(previewFile.contentType); return <Icon className="h-4 w-4 text-white" />; })()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{previewFile.fileName}</p>
                <p className="text-xs text-white/60">{formatFileSize(previewFile.size)}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-white hover:bg-white/10 hover:text-white"
                onClick={(e) => { e.stopPropagation(); handleDownload(previewFile); }}
              >
                <Download className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-white hover:bg-white/10 hover:text-white"
                onClick={(e) => { e.stopPropagation(); setPreviewFile(null); setPreviewUrl(null); }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="max-w-[90vw] max-h-[85vh] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            {previewLoading ? (
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-white" />
                <p className="text-sm text-white/70">{t.projects.files.loadingPreview}</p>
              </div>
            ) : previewUrl ? (
              <>
                {previewFile.contentType.startsWith('image/') && (
                  <img
                    src={previewUrl}
                    alt={previewFile.fileName}
                    className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg"
                  />
                )}
                {previewFile.contentType.startsWith('video/') && (
                  <video
                    src={previewUrl}
                    controls
                    autoPlay
                    className="max-w-[90vw] max-h-[85vh] rounded-lg"
                  />
                )}
                {previewFile.contentType.startsWith('audio/') && (
                  <div className="bg-white dark:bg-background p-8 rounded-lg flex flex-col items-center gap-4">
                    <FileAudio className="h-16 w-16 text-gray-400" />
                    <p className="text-sm font-medium">{previewFile.fileName}</p>
                    <audio src={previewUrl} controls autoPlay className="w-[400px]" />
                  </div>
                )}
                {previewFile.contentType === 'application/pdf' && (
                  <iframe
                    src={previewUrl}
                    className="w-[90vw] h-[85vh] rounded-lg bg-white"
                    title={previewFile.fileName}
                  />
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.files.deleteFileTitle}</DialogTitle>
            <DialogDescription>
              {t.projects.files.deleteFileConfirm.replace('{name}', fileToDelete?.fileName ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
              {t.projects.files.cancel}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                  {t.projects.files.deleting}
                </>
              ) : (
                t.projects.files.deleteMenuItem
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
