import {
  Image,
  FileVideo,
  FileAudio,
  FileText,
  FileSpreadsheet,
  FileCode,
  FileArchive,
  File,
  Mic,
  PenTool,
  Presentation,
  Star,
  MoreVertical,
  ExternalLink,
  Download,
  Pencil,
  FolderInput,
  Link,
  Trash2,
  Info,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { getTranslations } from '@/lib/i18n';

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';

function triggerAnchorDownload(href: string, filename: string, openInNewTab: boolean) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  if (openInNewTab) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function getClerkToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const clerk = (window as unknown as { Clerk?: { session?: { getToken: () => Promise<string | null> } } }).Clerk;
  if (clerk?.session) return clerk.session.getToken();
  return null;
}

/**
 * Download a UnifiedFile. Drive-source files (rows in the `files` table —
 * including WeldFlow documents/sheets stored as .docx/.xlsx in R2) stream
 * through the authenticated /api/files/:id/content endpoint, which:
 *   • respects tenant auth + RBAC instead of exposing public R2 paths
 *   • sets Content-Disposition so the browser saves with the correct name
 *   • returns a clear 404 when the R2 object hasn't been written yet
 *     (a freshly-created doc that's never been edited+saved)
 *
 * Other sources (mail attachments, voip recordings, etc.) keep their direct
 * URLs because they live in different tables / buckets.
 */
export async function downloadFile(
  file: Pick<UnifiedFile, 'id' | 'name' | 'url' | 'source'>,
): Promise<void> {
  const t = getTranslations('welddrive');
  if (file.source === 'drive') {
    try {
      const token = await getClerkToken();
      const res = await fetch(`${APP_API_URL}/api/files/${file.id}/content?download=1`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) {
        toast.error(t.toasts.noSavedContent);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      triggerAnchorDownload(blobUrl, file.name, false);
      URL.revokeObjectURL(blobUrl);
      return;
    } catch (err) {
      console.error('[downloadFile] drive download failed', err);
      toast.error(t.toasts.failedToDownloadFile);
      return;
    }
  }

  // Non-drive sources have a direct URL on the file row.
  if (!file.url) {
    toast.error(t.toasts.fileHasNoDownloadUrl);
    return;
  }
  try {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    triggerAnchorDownload(blobUrl, file.name, false);
    URL.revokeObjectURL(blobUrl);
  } catch {
    triggerAnchorDownload(file.url, file.name, true);
  }
}

interface DriveFileCardProps {
  file: UnifiedFile;
  isSelected?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onToggleStar?: (file: UnifiedFile) => void;
  onRename?: (file: UnifiedFile) => void;
  onMoveToFolder?: (file: UnifiedFile) => void;
  onCopyLink?: (file: UnifiedFile) => void;
  onDelete?: (file: UnifiedFile) => void;
  onDetails?: (file: UnifiedFile) => void;
}

const fileTypeIcons: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  image: { icon: Image, color: 'text-red-500' },
  video: { icon: FileVideo, color: 'text-purple-500' },
  audio: { icon: FileAudio, color: 'text-yellow-500' },
  pdf: { icon: FileText, color: 'text-red-600' },
  document: { icon: FileText, color: 'text-blue-500' },
  'rich-document': { icon: FileText, color: 'text-blue-500' },
  spreadsheet: { icon: FileSpreadsheet, color: 'text-green-500' },
  presentation: { icon: Presentation, color: 'text-orange-500' },
  recording: { icon: Mic, color: 'text-amber-500' },
  whiteboard: { icon: PenTool, color: 'text-violet-500' },
  archive: { icon: FileArchive, color: 'text-gray-500' },
  code: { icon: FileCode, color: 'text-cyan-500' },
  file: { icon: File, color: 'text-gray-400' },
};

const sourceBadgeStyles: Record<string, string> = {
  drive: 'text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950',
  projects: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950',
  documents: 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950',
  whiteboards: 'text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950',
  mail: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950',
  voip: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950',
  meetings: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950',
  social: 'text-pink-600 dark:text-pink-400 bg-pink-50 dark:bg-pink-950',
};

const driveLabelClass = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';

function formatFileSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function DriveFileCard({ file, isSelected, onClick, onDoubleClick, onToggleStar, onRename, onMoveToFolder, onCopyLink, onDelete, onDetails }: DriveFileCardProps) {
  const { t } = useI18n();
  const typeConfig = fileTypeIcons[file.fileType] || fileTypeIcons.file;
  const Icon = typeConfig.icon;
  const isImage = file.fileType === 'image' && (file.thumbnailUrl || file.url);

  return (
    <Button
      variant="ghost"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "group relative flex flex-col rounded-xl border bg-card text-card-foreground transition-colors text-left w-[241px] h-[241px] overflow-hidden",
        isSelected
          ? 'border-primary bg-primary/5 dark:bg-primary/10'
          : 'border-border/60 hover:border-border',
      )}
    >
      {/* Thumbnail / Preview area */}
      <div className="relative flex-1 min-h-0 bg-card flex items-center justify-center p-2 overflow-hidden">
        {isImage ? (
          <img
            src={file.url || file.thumbnailUrl!}
            alt={file.name}
            className="w-full h-full object-cover object-top rounded-[6px]"
          />
        ) : (
          <Icon className={cn('h-10 w-10 opacity-30', typeConfig.color)} />
        )}
        {file.isStarred && (
          <div className="absolute top-2.5 right-2.5">
            <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-3">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', typeConfig.color)} />
        <span className="text-[13px] font-medium text-foreground truncate min-w-0" title={file.name}>{file.name}</span>
        <div className="shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <div className="p-0.5 rounded-md hover:bg-muted cursor-pointer">
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52" sideOffset={4}>
              {file.url && (
                <DropdownMenuItem asChild>
                  <a href={file.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.openInNewTab}
                  </a>
                </DropdownMenuItem>
              )}
              {(file.source === 'drive' || file.url) && (
                <DropdownMenuItem onClick={() => downloadFile(file)}>
                  <Download className="h-4 w-4 mr-0.5" />
                  {t.welddrive.page.actions.download}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onDetails?.(file)}>
                <Info className="h-4 w-4 mr-0.5" />
                {t.welddrive.page.actions.details}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onToggleStar?.(file)}>
                <Star className={cn("h-4 w-4 mr-0.5", file.isStarred && "fill-yellow-400 text-yellow-400")} />
                {file.isStarred ? t.welddrive.page.actions.removeFromStarred : t.welddrive.page.actions.addToStarred}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRename?.(file)}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.welddrive.page.actions.rename}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMoveToFolder?.(file)}>
                <FolderInput className="h-4 w-4 mr-0.5" />
                {t.welddrive.page.actions.moveToFolder}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                if (onCopyLink) {
                  onCopyLink(file);
                } else if (file.url) {
                  navigator.clipboard.writeText(file.url);
                }
              }}>
                <Link className="h-4 w-4 mr-0.5" />
                {t.welddrive.page.actions.copyLink}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
                onClick={() => onDelete?.(file)}
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                {t.welddrive.page.actions.moveToTrash}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Button>
  );
}

// Re-export for use in list view
export { fileTypeIcons, sourceBadgeStyles, driveLabelClass, formatFileSize, formatDate };
