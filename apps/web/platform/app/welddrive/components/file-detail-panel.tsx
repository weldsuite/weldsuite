import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import {
  X,
  Download,
  ExternalLink,
  Pencil,
  FolderInput,
  Star,
  Trash2,
  EllipsisVertical,
  Link,
  History,
  Upload,
  Edit,
  LayoutGrid,
  HardDrive,
  FileText,
  Copy,
  UserPlus,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { fileTypeIcons, sourceBadgeStyles, driveLabelClass, formatFileSize, formatDate, downloadFile } from './drive-file-card';
import { DriveFileAccess } from './drive-access-list';
import { driveSourceKey, driveSourceLabel } from './drive-utils';
import { CommentsList, DescriptionField, type TaskComment } from '@/components/task-detail/task-detail-content';
import { AuditTimeline, AuditTimelineSkeleton } from '@/components/audit-timeline';
import { useEntityAuditLogs } from '@/hooks/queries/use-audit-log-queries';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { copyText } from '@/lib/clipboard';

// ---------- Types ----------

interface FileDetailPanelProps {
  file: UnifiedFile | null;
  isOpen: boolean;
  onClose: () => void;
  onToggleStar?: (file: UnifiedFile) => void;
  onRename?: (file: UnifiedFile) => void;
  onMoveToFolder?: (file: UnifiedFile) => void;
  onCopyLink?: (file: UnifiedFile) => void;
  onDelete?: (file: UnifiedFile) => void;
  onPreview?: (file: UnifiedFile) => void;
  onShare?: (file: UnifiedFile) => void;
  description?: string;
  /** Saves the description; without it (files from other modules) none is shown. */
  onDescriptionChange?: (description: string) => void;
  comments?: TaskComment[];
  onAddComment?: (content: string) => void;
  onUpdateComment?: (commentId: string, content: string) => void;
  onDeleteComment?: (commentId: string) => void;
  currentUserId?: string;
  width?: string;
}

// ---------- Constants ----------

// Tabs are built inside the component so labels can be translated

function formatActivityDate(dateStr: string, justNowLabel: string, minutesAgoTemplate: string, hoursAgoTemplate: string, daysAgoTemplate: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return justNowLabel;
  if (diffMins < 60) return minutesAgoTemplate.replace('{count}', String(diffMins));
  if (diffHours < 24) return hoursAgoTemplate.replace('{count}', String(diffHours));
  if (diffDays < 7) return daysAgoTemplate.replace('{count}', String(diffDays));
  return formatDate(dateStr);
}

/**
 * A drive file's history from the audit log: who uploaded, renamed or
 * described it, with the old and new values. Files from other modules, and
 * files without recorded history, fall back to what the row itself tells.
 */
function FileActivity({ file }: Readonly<{ file: UnifiedFile }>) {
  const { t } = useI18n();
  const isDriveFile = file.source === 'drive';
  const { data, isLoading } = useEntityAuditLogs(isDriveFile ? 'file' : '', file.id);

  if (isDriveFile && isLoading) return <AuditTimelineSkeleton />;

  const logs = (data?.data ?? []).map((log) => ({
    id: log.id,
    action: log.action,
    description: log.description,
    changes: log.changes,
    performedBy: log.performedBy,
    performedByName: log.performedByName,
    createdAt: log.createdAt,
  }));
  if (logs.length > 0) return <AuditTimeline logs={logs} alwaysShowChanges />;

  const activityItems = [
    ...(file.updatedAt && file.updatedAt !== file.createdAt
      ? [{ id: 'updated', icon: Edit, text: t.welddrive.fileDetail.activity.fileModified, date: file.updatedAt }]
      : []),
    { id: 'created', icon: Upload, text: t.welddrive.fileDetail.activity.fileUploaded, date: file.createdAt },
  ];

  return (
    <div>
      {activityItems.map((item, index) => {
        const ActivityIcon = item.icon;
        const isLast = index === activityItems.length - 1;
        return (
          <div key={item.id} className="flex">
            <div className="relative shrink-0" style={{ width: 20 }}>
              <div className="relative z-10 w-5 h-5 rounded-md flex items-center justify-center bg-muted" style={{ marginTop: 3 }}>
                <ActivityIcon className="w-2.5 h-2.5 text-muted-foreground" />
              </div>
              {!isLast && <div className="absolute bg-border" style={{ left: 9, top: 28, bottom: 5, width: 1 }} />}
            </div>
            <div className={cn("flex-1 min-w-0 pl-2.5", !isLast && "pb-7")}>
              <div className="flex items-start pt-0.5">
                <p className="flex-1 text-[14px] text-muted-foreground">{item.text}</p>
                <span className="text-[12px] text-muted-foreground/60 shrink-0 ml-3">{formatActivityDate(item.date, t.welddrive.fileDetail.activity.justNow, t.welddrive.fileDetail.timeAgo.minutesAgo, t.welddrive.fileDetail.timeAgo.hoursAgo, t.welddrive.fileDetail.timeAgo.daysAgo)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Component ----------

export function FileDetailPanel({
  file,
  isOpen,
  onClose,
  onToggleStar,
  onRename,
  onMoveToFolder,
  onCopyLink,
  onDelete,
  onPreview,
  onShare,
  description,
  onDescriptionChange,
  comments,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  currentUserId,
  width = '500px',
}: Readonly<FileDetailPanelProps>) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState('overview');
  const widthNum = Number.parseInt(width, 10) || 500;

  const panelTabs: PageTab[] = [
    { id: 'overview', label: t.welddrive.fileDetail.tabs.overview, icon: LayoutGrid },
    { id: 'activity', label: t.welddrive.fileDetail.tabs.activity, icon: History },
  ];

  // Resizable comments area (same as TaskDetailPanel)
  const commentsContainerRef = useRef<HTMLDivElement>(null);
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const isDraggingRef = useRef(false);

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    isDraggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current || !commentsContainerRef.current) return;
    const panelRect = commentsContainerRef.current.parentElement?.getBoundingClientRect();
    if (!panelRect) return;
    const newHeight = panelRect.bottom - e.clientY;
    setManualHeight(Math.min(Math.max(newHeight, 100), 600));
  }, []);

  const handleResizePointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  useEffect(() => { setActiveTab('overview'); }, [file?.id]);

  useEffect(() => {
    if (isOpen) window.dispatchEvent(new CustomEvent('close-weldagent'));
  }, [isOpen]);

  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent('file-detail-panel', { detail: { isOpen, width: widthNum } }));
    return () => { window.dispatchEvent(new CustomEvent('file-detail-panel', { detail: { isOpen: false, width: 0 } })); };
  }, [isOpen, widthNum]);

  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, [onClose]);

  if (!isOpen || !file) return null;

  const typeConfig = fileTypeIcons[file.fileType] || fileTypeIcons.file;
  const Icon = typeConfig.icon;
  const badgeClass = sourceBadgeStyles[driveSourceKey(file)] || sourceBadgeStyles.drive;
  const isImage = file.fileType === 'image' && (file.url || file.thumbnailUrl);

  const detailFields = [
    { icon: typeConfig.icon, label: t.welddrive.fileDetail.fields.type, value: <span className="capitalize">{file.fileType}</span> },
    { icon: HardDrive, label: t.welddrive.fileDetail.fields.size, value: file.fileSize !== null ? formatFileSize(file.fileSize) : '--' },
    { icon: HardDrive, label: t.welddrive.fileDetail.fields.source, value: <span className={cn(driveLabelClass, badgeClass)}>{driveSourceLabel(file, t)}</span> },
    { icon: FileText, label: t.welddrive.fileDetail.fields.created, value: <span className="tabular-nums">{formatDate(file.createdAt)}</span> },
  ];
  if (file.updatedAt) detailFields.push({ icon: FileText, label: t.welddrive.fileDetail.fields.updated, value: <span className="tabular-nums">{formatDate(file.updatedAt)}</span> });
  if (file.mimeType) detailFields.push({ icon: FileText, label: t.welddrive.fileDetail.fields.mime, value: <span className="text-xs font-mono text-muted-foreground">{file.mimeType}</span> });

  return (
    <div
      className={cn(
        "fixed bg-background z-50 flex flex-col border-l border-border overflow-x-hidden",
        "inset-0",
        "md:inset-auto md:right-0 md:top-[60px] md:bottom-0",
        "transition-transform duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]",
        isOpen ? "translate-x-0" : "translate-x-full",
        !isOpen && "pointer-events-none",
      )}
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 md:px-4 py-3 shrink-0 overflow-hidden">
        {/* Icon + Title */}
        <Icon className={cn('h-4 w-4 shrink-0', typeConfig.color)} />
        <h1 className="text-[15px] font-medium text-foreground truncate flex-1 min-w-0">{file.name}</h1>

        {/* Buttons */}
        <div className="flex items-center gap-0.5 md:gap-1 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none focus-visible:outline-none h-auto w-auto">
                <EllipsisVertical className="h-4 w-4 text-gray-500" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {file.url && (
                <DropdownMenuItem asChild>
                  <a href={file.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-0.5" />
                    {t.welddrive.fileDetail.actions.openInNewTab}
                  </a>
                </DropdownMenuItem>
              )}
              {(file.source === 'drive' || file.url) && (
                <DropdownMenuItem onClick={() => downloadFile(file)}>
                  <Download className="h-4 w-4 mr-0.5" />
                  {t.welddrive.fileDetail.actions.download}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => {
                if (onCopyLink) onCopyLink(file);
                else if (file.url) copyText(file.url);
              }}>
                <Link className="h-4 w-4 mr-0.5" />
                {t.welddrive.fileDetail.actions.copyLink}
              </DropdownMenuItem>
              {onShare && (
                <DropdownMenuItem onClick={() => onShare(file)}>
                  <UserPlus className="h-4 w-4 mr-0.5" />
                  {t.welddrive.fileDetail.actions.share}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onToggleStar?.(file)}>
                <Star className={cn("h-4 w-4 mr-0.5", file.isStarred && "fill-yellow-400 text-yellow-400")} />
                {file.isStarred ? t.welddrive.fileDetail.actions.removeFromStarred : t.welddrive.fileDetail.actions.addToStarred}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRename?.(file)}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.welddrive.fileDetail.actions.rename}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMoveToFolder?.(file)}>
                <FolderInput className="h-4 w-4 mr-0.5" />
                {t.welddrive.fileDetail.actions.moveToFolder}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Copy className="h-4 w-4 mr-0.5" />
                {t.welddrive.fileDetail.actions.duplicate}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950" onClick={() => onDelete?.(file)}>
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                {t.welddrive.fileDetail.actions.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" className="p-1.5 hover:bg-muted rounded-md transition-colors h-auto w-auto" onClick={onClose} title={t.welddrive.fileDetail.actions.close}>
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        </div>
      </div>

      {/* Description under title, saved on blur */}
      {onDescriptionChange && (
        <div className="px-1 md:px-2 -mt-2 pb-3">
          <DescriptionField
            key={file.id}
            taskId={file.id}
            description={description}
            onUpdate={(_id, data) => onDescriptionChange(data.description || '')}
          />
        </div>
      )}

      {/* Tabs */}
      <div className="relative z-10 px-4">
        <PageTabs tabs={panelTabs} activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="flex-1 overflow-y-auto overflow-x-hidden customer-detail-scroll transition-opacity duration-200 min-w-0">

          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="px-4 pb-4">
              <div className="mt-2">
                {detailFields.map((field) => (
                  <div key={field.label} className="flex items-center gap-3 py-2">
                    <div className="flex items-center gap-2 w-32 shrink-0">
                      <field.icon className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">{field.label}</span>
                    </div>
                    <div className="flex-1 text-sm text-foreground min-w-0">{field.value}</div>
                  </div>
                ))}
              </div>

              {isImage && (
                <button
                  type="button"
                  className="mt-4 block w-full p-0 rounded-lg overflow-hidden bg-muted/30 border border-border/50 cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => onPreview?.(file)}
                >
                  <img src={file.url || file.thumbnailUrl!} alt={file.name} className="w-full object-contain max-h-[300px]" />
                </button>
              )}

              {/* Who has access */}
              <div className="mt-4 border-t border-border/50 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-foreground">{t.welddrive.fileDetail.whoHasAccess}</span>
                  {onShare && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => onShare(file)}>
                      <UserPlus className="h-3.5 w-3.5 mr-1" />
                      {t.welddrive.fileDetail.actions.share}
                    </Button>
                  )}
                </div>
                <DriveFileAccess file={file} />
              </div>

            </div>
          )}

          {/* Activity Tab */}
          {activeTab === 'activity' && (
            <div className="px-4 pb-4 mt-4">
              <FileActivity file={file} />
            </div>
          )}
        </div>
      </div>

      {/* Comments — pinned at bottom with resizable handle (same as TaskDetailPanel) */}
      {onAddComment && (
        <div ref={commentsContainerRef} className="flex-shrink-0 flex flex-col" style={manualHeight != null ? { height: manualHeight } : { maxHeight: 300 }}>
          {/* Drag handle */}
          <div
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            className={cn(
              "h-[9px] flex-shrink-0 cursor-row-resize flex items-center justify-center group touch-none",
              (comments?.length ?? 0) > 0 && "border-t border-border"
            )}
          >
            <div className="w-8 h-[3px] rounded-full bg-gray-300 dark:bg-border opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="flex-1 min-h-0 flex flex-col px-4 pb-4">
            <CommentsList
              comments={comments || []}
              currentUserId={currentUserId}
              onAddComment={onAddComment}
              onUpdateComment={onUpdateComment}
              onDeleteComment={onDeleteComment}
            />
          </div>
        </div>
      )}
    </div>
  );
}
