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
import { CommentsList, DescriptionField, type TaskComment } from '@/components/task-detail/task-detail-content';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { useUser } from '@clerk/clerk-react';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';

// ---------- Types ----------

// Shape of a `/team-members` row as consumed here — see `useWorkspaceMembers`
// for the full (visibility-projected) field set; only what this panel reads.
interface DriveAccessMember {
  id?: string;
  userId: string;
  name: string;
  picture?: string | null;
}

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
  description?: string;
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
  description,
  onDescriptionChange,
  comments,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  currentUserId,
  width = '500px',
}: FileDetailPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState('overview');
  const widthNum = parseInt(width, 10) || 500;
  const { user } = useUser();
  const { data: membersData } = useWorkspaceMembers();

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
  const badgeClass = sourceBadgeStyles[file.source] || sourceBadgeStyles.drive;
  const isImage = file.fileType === 'image' && (file.url || file.thumbnailUrl);

  const detailFields = [
    { icon: typeConfig.icon, label: t.welddrive.fileDetail.fields.type, value: <span className="capitalize">{file.fileType}</span> },
    { icon: HardDrive, label: t.welddrive.fileDetail.fields.size, value: file.fileSize !== null ? formatFileSize(file.fileSize) : '--' },
    { icon: HardDrive, label: t.welddrive.fileDetail.fields.source, value: <span className={cn(driveLabelClass, badgeClass)}>{file.sourceLabel}</span> },
    { icon: FileText, label: t.welddrive.fileDetail.fields.created, value: formatDate(file.createdAt) },
  ];
  if (file.updatedAt) detailFields.push({ icon: FileText, label: t.welddrive.fileDetail.fields.updated, value: formatDate(file.updatedAt) });
  if (file.mimeType) detailFields.push({ icon: FileText, label: t.welddrive.fileDetail.fields.mime, value: <span className="text-xs font-mono text-muted-foreground">{file.mimeType}</span> });

  const activityItems = [
    ...(file.updatedAt && file.updatedAt !== file.createdAt
      ? [{ id: 'updated', icon: Edit, text: t.welddrive.fileDetail.activity.fileModified, date: file.updatedAt }]
      : []),
    { id: 'created', icon: Upload, text: t.welddrive.fileDetail.activity.fileUploaded, date: file.createdAt },
  ];

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
                else if (file.url) navigator.clipboard.writeText(file.url);
              }}>
                <Link className="h-4 w-4 mr-0.5" />
                {t.welddrive.fileDetail.actions.copyLink}
              </DropdownMenuItem>
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

      {/* Description under title */}
      <div className="px-1 md:px-2 -mt-2 pb-3">
        <DescriptionField
          taskId={file.id}
          description={description}
          onUpdate={(_id, data) => onDescriptionChange?.(data.description || '')}
        />
      </div>

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
                <div
                  className="mt-4 rounded-lg overflow-hidden bg-muted/30 border border-border/50 cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => onPreview?.(file)}
                >
                  <img src={file.url || file.thumbnailUrl!} alt={file.name} className="w-full object-contain max-h-[300px]" />
                </div>
              )}

              {/* Who has access */}
              {(() => {
                const members = (membersData?.data || []) as DriveAccessMember[];
                const owner = file.uploadedById
                  ? members.find((m) => m.userId === file.uploadedById) || null
                  : null;

                return (
                  <div className="mt-4 border-t border-border/50 pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-medium text-foreground">{t.welddrive.fileDetail.whoHasAccess}</span>
                    </div>
                    <div className="space-y-2.5">
                      {owner && (
                        <div className="flex items-center gap-2.5">
                          {owner.picture ? (
                            <img src={owner.picture} alt={owner.name} className="w-[22px] h-[22px] rounded-[8px] object-cover shrink-0" />
                          ) : (
                            <div className="w-[22px] h-[22px] rounded-[8px] bg-primary flex items-center justify-center shrink-0">
                              <span className="text-[10px] font-semibold text-primary-foreground">
                                {(owner.name || '?').split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase()}
                              </span>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-foreground truncate block">{owner.name}</span>
                          </div>
                          <span className={cn(driveLabelClass, 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950')}>{t.welddrive.fileDetail.accessRoles.owner}</span>
                        </div>
                      )}
                      {user && (!owner || owner.userId !== user.id) && (
                        <div className="flex items-center gap-2.5">
                          {user.imageUrl ? (
                            <img src={user.imageUrl} alt={user.fullName || ''} className="w-[22px] h-[22px] rounded-[8px] object-cover shrink-0" />
                          ) : (
                            <div className="w-[22px] h-[22px] rounded-[8px] bg-emerald-500 flex items-center justify-center shrink-0">
                              <span className="text-[10px] font-semibold text-white">
                                {(user.fullName || '?').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
                              </span>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-foreground truncate block">{user.fullName || t.welddrive.fileDetail.you}</span>
                          </div>
                          <span className={cn(driveLabelClass, 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950')}>{t.welddrive.fileDetail.accessRoles.canEdit}</span>
                        </div>
                      )}
                      {members
                        .filter((m) => m.userId !== file.uploadedById && m.userId !== user?.id)
                        .slice(0, 5)
                        .map((m) => (
                          <div key={m.userId || m.id} className="flex items-center gap-2.5">
                            {m.picture ? (
                              <img src={m.picture} alt={m.name} className="w-[22px] h-[22px] rounded-[8px] object-cover shrink-0" />
                            ) : (
                              <div className="w-[22px] h-[22px] rounded-[8px] bg-muted flex items-center justify-center shrink-0">
                                <span className="text-[10px] font-medium text-muted-foreground">
                                  {(m.name || '?').split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase()}
                                </span>
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-foreground truncate block">{m.name}</span>
                            </div>
                            <span className={cn(driveLabelClass, 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary')}>{t.welddrive.fileDetail.accessRoles.canView}</span>
                          </div>
                        ))}
                      {members.filter((m) => m.userId !== file.uploadedById && m.userId !== user?.id).length > 5 && (
                        <span className="text-xs text-muted-foreground pl-8">
                          {t.welddrive.fileDetail.moreMembers.replace('{count}', String(members.filter((m) => m.userId !== file.uploadedById && m.userId !== user?.id).length - 5))}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}

            </div>
          )}

          {/* Activity Tab */}
          {activeTab === 'activity' && (
            <div className="px-4 pb-4 mt-4">
              {activityItems.length === 0 ? (
                <div className="py-12 text-center">
                  <History className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">{t.welddrive.fileDetail.activity.noActivity}</p>
                </div>
              ) : (
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
              )}
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
