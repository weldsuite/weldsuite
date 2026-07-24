
import { useState, useRef, useCallback, useMemo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Download,
  EllipsisVertical,
  Trash2,
  FileText,
  File,
  Image,
  FileVideo,
  FileAudio,
  FileArchive,
  ExternalLink,
  Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type ActiveFilter } from '@/components/entity-list';
import type { FilesSectionProps } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

// File item type
interface FileItem {
  id: string;
  name: string;
  size: number;
  type: string;
  fileType: string;
  date: Date;
  url?: string;
}

// File type detection
const getFileType = (mimeType: string): string => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return 'archive';
  if (mimeType.includes('pdf')) return 'pdf';
  if (mimeType.includes('document') || mimeType.includes('word')) return 'document';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return 'spreadsheet';
  return 'other';
};

const getFileIcon = (mimeType: string) => {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return FileVideo;
  if (mimeType.startsWith('audio/')) return FileAudio;
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return FileArchive;
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('word')) return FileText;
  return File;
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const formatDate = (date: Date): string => {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// `customer` isn't read here, but the parameter must stay to match the
// shared `SectionProps` contract every `<XSection customer={...} />` caller uses.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function FilesSection(_props: FilesSectionProps) {
  const t = useTranslations();
  const [files, setFiles] = useState<FileItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle file upload (local state for now)
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles) return;

    const newFiles: FileItem[] = Array.from(uploadedFiles).map(file => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      size: file.size,
      type: file.type,
      fileType: getFileType(file.type),
      date: new Date(),
    }));

    setFiles(prev => [...newFiles, ...prev]);
    toast.success(t('sweep.weldcrm.filesSection.filesUploaded', { count: uploadedFiles.length }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [t]);

  const handleDeleteFile = useCallback((id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
    toast.success(t('sweep.weldcrm.filesSection.fileDeleted'));
  }, [t]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'fileType',
      label: t('sweep.weldcrm.filesSection.type'),
      options: [
        { value: 'image', label: t('sweep.weldcrm.filesSection.images') },
        { value: 'video', label: t('sweep.weldcrm.filesSection.videos') },
        { value: 'audio', label: t('sweep.weldcrm.filesSection.audio') },
        { value: 'pdf', label: t('sweep.weldcrm.filesSection.pdfs') },
        { value: 'document', label: t('sweep.weldcrm.filesSection.documents') },
        { value: 'spreadsheet', label: t('sweep.weldcrm.filesSection.spreadsheets') },
        { value: 'archive', label: t('sweep.weldcrm.filesSection.archives') },
        { value: 'other', label: t('sweep.weldcrm.filesSection.other') },
      ],
    },
  ], [t]);

  // Apply filters
  const applyFilters = useCallback((items: FileItem[], filters: ActiveFilter[]) => {
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
    { id: 'name', header: t('sweep.weldcrm.contactsSection.name'), width: 'flex-1 min-w-0' },
    { id: 'type', header: t('sweep.weldcrm.filesSection.type'), width: 'w-[100px]' },
    { id: 'size', header: t('sweep.weldcrm.filesSection.size'), width: 'w-[90px]' },
    { id: 'uploaded', header: t('sweep.weldcrm.filesSection.uploaded'), width: 'w-[120px]' },
  ], [t]);

  // Render row
  const renderRow = useCallback((file: FileItem) => {
    const Icon = getFileIcon(file.type);

    return (
      <div
        key={file.id}
        className="flex items-center gap-4 px-4 py-3 border-b border-border/70 group hover:bg-muted/50"
      >
        {/* File Icon & Name */}
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <div className="flex-shrink-0 flex items-center justify-center h-9 w-9 rounded-lg bg-muted">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-medium text-foreground truncate">
            {file.name}
          </span>
        </div>

        {/* Type */}
        <div className="w-[100px] flex-shrink-0">
          <span className="text-sm text-muted-foreground capitalize">{file.fileType}</span>
        </div>

        {/* Size */}
        <div className="w-[90px] flex-shrink-0">
          <span className="text-sm text-muted-foreground">{formatFileSize(file.size)}</span>
        </div>

        {/* Uploaded */}
        <div className="w-[120px] flex-shrink-0">
          <span className="text-sm text-muted-foreground">{formatDate(file.date)}</span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem>
                <Download className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.filesSection.download')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <ExternalLink className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.filesSection.open')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Copy className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.copyLink')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleDeleteFile(file.id)}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
                {t('sweep.weldcrm.customerDetailSidebar.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [handleDeleteFile, t]);

  return (
    <>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileUpload}
      />

      <EntityList<FileItem>
        items={files}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        maxFilters={3}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={t('sweep.weldcrm.filesSection.searchFiles')}
        searchFields={['name']}
        emptyStateClassName="pb-24"
        createButton={{
          label: t('sweep.weldcrm.filesSection.uploadFile'),
          onClick: () => fileInputRef.current?.click(),
        }}
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
          title: t('sweep.weldcrm.filesSection.noFilesYet'),
          description: t('sweep.weldcrm.filesSection.noFilesYetDescription'),
          action: {
            label: t('sweep.weldcrm.filesSection.uploadFile'),
            onClick: () => fileInputRef.current?.click(),
          },
        }}
        noResultsState={{
          title: t('sweep.weldcrm.filesSection.noFilesFound'),
          description: t('sweep.weldcrm.filesSection.noFilesFoundDescription'),
        }}
      />
    </>
  );
}
