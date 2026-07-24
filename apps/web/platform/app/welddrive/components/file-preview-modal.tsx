import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Download,
  ExternalLink,
  X,
  Minus,
  Plus,
  RotateCwSquare,
  Fullscreen,
  Info,
  Star,
  FolderInput,
  Pencil,
  Link,
  Trash2,
  MoreVertical,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { createPortal } from 'react-dom';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { fileTypeIcons, sourceBadgeStyles, driveLabelClass, formatFileSize, formatDate, downloadFile } from './drive-file-card';
import { cn } from '@/lib/utils';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';

function PreviewTooltip({ label, children, side = 'top' }: { label: string; children: React.ReactNode; side?: 'top' | 'bottom' }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovering = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const hasOpenDropdown = useCallback(() => {
    return !!triggerRef.current?.querySelector('[data-state="open"]');
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    if (!hovering.current || hasOpenDropdown()) return;
    timerRef.current = setTimeout(() => {
      if (!hovering.current || hasOpenDropdown()) return;
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        if (side === 'bottom') {
          setPos({ x: rect.left + rect.width / 2, y: rect.bottom + 8 });
        } else {
          setPos({ x: rect.left + rect.width / 2, y: rect.top - 8 });
        }
      }
      setShow(true);
    }, 600);
  }, [clearTimer, hasOpenDropdown, side]);

  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (hasOpenDropdown()) { clearTimer(); setShow(false); }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-state'], subtree: true });
    return () => observer.disconnect();
  }, [clearTimer, hasOpenDropdown]);

  return (
    <div
      ref={triggerRef}
      className="inline-flex"
      onMouseEnter={() => { hovering.current = true; startTimer(); }}
      onMouseLeave={() => { hovering.current = false; clearTimer(); setShow(false); }}
      onMouseDown={() => { clearTimer(); setShow(false); }}
    >
      {children}
      {createPortal(
        <div
          className={cn(
            "fixed px-2 py-1 bg-white text-gray-900 text-[11px] rounded-md whitespace-nowrap pointer-events-none z-[9999] -translate-x-1/2 transition-opacity duration-150",
            side === 'bottom' ? 'translate-y-0' : '-translate-y-full'
          )}
          style={{ left: pos.x, top: pos.y, opacity: show ? 1 : 0 }}
        >
          {label}
        </div>,
        document.body,
      )}
    </div>
  );
}

interface FilePreviewModalProps {
  file: UnifiedFile | null;
  open: boolean;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onToggleStar?: (file: UnifiedFile) => void;
  onMoveToFolder?: (file: UnifiedFile) => void;
  onRename?: (file: UnifiedFile) => void;
  onCopyLink?: (file: UnifiedFile) => void;
  onDelete?: (file: UnifiedFile) => void;
}

export function FilePreviewModal({ file, open, onClose, onNext, onPrevious, onToggleStar, onMoveToFolder, onRename, onCopyLink, onDelete }: FilePreviewModalProps) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [skipTransition, setSkipTransition] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Reset state when file changes
  useEffect(() => {
    setZoom(1);
    setRotation(0);
  }, [file?.id]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If a popover or dropdown is open, let it handle Escape first
        const openOverlay = document.querySelector('[data-radix-popper-content-wrapper]');
        if (openOverlay) return;
        onClose();
      }
      if (e.key === 'ArrowRight' && onNext) onNext();
      if (e.key === 'ArrowLeft' && onPrevious) onPrevious();
      if (e.key === '+' || e.key === '=') setZoom(z => Math.min(z + 0.25, 5));
      if (e.key === '-') setZoom(z => Math.max(z - 0.25, 0.25));
      if (e.key === '0') setZoom(1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose, onNext, onPrevious]);

  const handleZoomIn = useCallback(() => setZoom(z => Math.min(z + 0.25, 5)), []);
  const handleZoomOut = useCallback(() => setZoom(z => Math.max(z - 0.25, 0.25)), []);
  const handleRotate = useCallback(() => setRotation(r => r + 90), []);
  const handleFitToScreen = useCallback(() => {
    setZoom(1);
    setRotation(prev => {
      const mod = prev % 360;
      if (mod === 0) {
        // Already visually at 0 — skip the transition and just reset
        setSkipTransition(true);
        requestAnimationFrame(() => setSkipTransition(false));
        return 0;
      }
      // Strip full rotations instantly (no transition), keep remainder
      setSkipTransition(true);
      // After snap, animate remainder back to 0
      requestAnimationFrame(() => {
        setSkipTransition(false);
        requestAnimationFrame(() => setRotation(0));
      });
      return mod;
    });
  }, []);

  if (!open || !file) return null;

  const typeConfig = fileTypeIcons[file.fileType] || fileTypeIcons.file;
  const Icon = typeConfig.icon;
  const badgeClass = sourceBadgeStyles[file.source] || sourceBadgeStyles.drive;

  const isImage = file.fileType === 'image' && file.url;
  const isVideo = (file.fileType === 'video' || (file.fileType === 'recording' && file.mimeType?.startsWith('video/'))) && file.url;
  const isAudio = (file.fileType === 'audio' || (file.fileType === 'recording' && !file.mimeType?.startsWith('video/'))) && file.url;
  const isPdf = file.fileType === 'pdf' && file.url;

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />

      {/* Top Bar */}
      <div className="relative z-10 flex items-center justify-between h-14 px-4">
        {/* Left: close + file name */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <PreviewTooltip label={t.welddrive.filePreview.tooltips.close} side="bottom">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10"
              onClick={onClose}
            >
              <X className="size-5" />
            </Button>
          </PreviewTooltip>
          <Icon className={cn('h-5 w-5 shrink-0', typeConfig.color)} />
          <span className="text-sm font-medium text-white truncate">{file.name}</span>
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-1">
            {file.navigateTo && (
              <PreviewTooltip label={t.welddrive.filePreview.tooltips.openInModule} side="bottom">
                <Button variant="ghost" size="sm" className="h-9 w-9 p-0 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10" asChild>
                  <a href={file.navigateTo}>
                    <ExternalLink className="size-5" />
                  </a>
                </Button>
              </PreviewTooltip>
            )}

            <PreviewTooltip label={t.welddrive.filePreview.tooltips.details} side="bottom">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 w-9 p-0 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10 data-[state=open]:text-white"
                  >
                    <Info className="size-5" />
                  </Button>
                </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1" sideOffset={6}>
                {isImage && file.thumbnailUrl && (
                  <div className="mx-1 mb-1 rounded-md overflow-hidden bg-muted">
                    <img src={file.thumbnailUrl} alt="" className="w-full object-cover" />
                  </div>
                )}
                <div className="flex items-center justify-between px-2 py-1.5 text-sm">
                  <span className="text-muted-foreground">{t.welddrive.filePreview.details.type}</span>
                  <span className="capitalize">{file.fileType}</span>
                </div>
                {file.fileSize !== null && (
                  <div className="flex items-center justify-between px-2 py-1.5 text-sm">
                    <span className="text-muted-foreground">{t.welddrive.filePreview.details.size}</span>
                    <span>{formatFileSize(file.fileSize)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between px-2 py-1.5 text-sm">
                  <span className="text-muted-foreground">{t.welddrive.filePreview.details.source}</span>
                  <span className={cn(driveLabelClass, badgeClass)}>
                    {file.sourceLabel}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2 py-1.5 text-sm">
                  <span className="text-muted-foreground">{t.welddrive.filePreview.details.modified}</span>
                  <span>{formatDate(file.createdAt)}</span>
                </div>
                {file.updatedAt && (
                  <div className="flex items-center justify-between px-2 py-1.5 text-sm">
                    <span className="text-muted-foreground">{t.welddrive.filePreview.details.updated}</span>
                    <span>{formatDate(file.updatedAt)}</span>
                  </div>
                )}
                {file.mimeType && (
                  <>
                    <div className="h-px bg-border mx-1 my-1" />
                    <div className="flex items-center justify-between px-2 py-1.5 text-sm">
                      <span className="text-muted-foreground">{t.welddrive.filePreview.details.mime}</span>
                      <span className="text-xs text-muted-foreground font-mono truncate ml-2">{file.mimeType}</span>
                    </div>
                  </>
                )}
              </PopoverContent>
              </Popover>
            </PreviewTooltip>

            {(file.source === 'drive' || file.url) && (
              <PreviewTooltip label={t.welddrive.filePreview.tooltips.download} side="bottom">
                <Button variant="ghost" size="sm" className="h-9 w-9 p-0 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10" onClick={() => downloadFile(file)}>
                  <Download className="size-5" />
                </Button>
              </PreviewTooltip>
            )}

            <PreviewTooltip label={t.welddrive.filePreview.tooltips.moreOptions} side="bottom">
              <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-9 w-9 p-0 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10 data-[state=open]:text-white">
                  <MoreVertical className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52" sideOffset={6}>
                {file.url && (
                  <DropdownMenuItem asChild>
                    <a href={file.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4 mr-0.5" />
                      {t.welddrive.filePreview.actions.openInNewTab}
                    </a>
                  </DropdownMenuItem>
                )}
                {file.navigateTo && (
                  <DropdownMenuItem asChild>
                    <a href={file.navigateTo}>
                      <ExternalLink className="h-4 w-4 mr-0.5" />
                      {t.welddrive.filePreview.actions.openInModule}
                    </a>
                  </DropdownMenuItem>
                )}
                {(file.source === 'drive' || file.url) && (
                  <DropdownMenuItem onClick={() => downloadFile(file)}>
                    <Download className="h-4 w-4 mr-0.5" />
                    {t.welddrive.filePreview.actions.download}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onToggleStar?.(file)}>
                  <Star className={cn("h-4 w-4 mr-0.5", file.isStarred && "fill-yellow-400 text-yellow-400")} />
                  {file.isStarred ? t.welddrive.filePreview.actions.removeFromStarred : t.welddrive.filePreview.actions.addToStarred}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRename?.(file)}>
                  <Pencil className="h-4 w-4 mr-0.5" />
                  {t.welddrive.filePreview.actions.rename}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMoveToFolder?.(file)}>
                  <FolderInput className="h-4 w-4 mr-0.5" />
                  {t.welddrive.filePreview.actions.moveToFolder}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => {
                  if (onCopyLink) {
                    onCopyLink(file);
                  } else if (file.url) {
                    navigator.clipboard.writeText(file.url);
                  }
                }}>
                  <Link className="h-4 w-4 mr-0.5" />
                  {t.welddrive.filePreview.actions.copyLink}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
                  onClick={() => onDelete?.(file)}
                >
                  <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                  {t.welddrive.filePreview.actions.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </PreviewTooltip>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="relative z-10 flex-1 flex min-h-0">
        {/* Navigation arrows */}
        {onPrevious && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onPrevious}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm flex items-center justify-center text-white/70 hover:text-white transition-colors"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
        )}
        {onNext && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm flex items-center justify-center text-white/70 hover:text-white transition-colors"
          >
            <ChevronRight className="h-5 w-5" />
          </Button>
        )}

        {/* Preview Area */}
        <div
          className="flex-1 flex items-center justify-center overflow-auto p-8"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          {isImage && (
            <img
              src={file.url!}
              alt={file.name}
              ref={imgRef}
              className={cn("max-w-full max-h-full object-contain select-none shadow-[0_8px_36px_rgba(0,0,0,0.14)]", !skipTransition && "transition-transform duration-200")}
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
              }}
              draggable={false}
            />
          )}

          {isVideo && (
            <video
              src={file.url!}
              controls
              poster={file.thumbnailUrl || undefined}
              className="max-w-full max-h-full rounded-lg shadow-[0_8px_36px_rgba(0,0,0,0.14)]"
            />
          )}

          {isAudio && (
            <div className="flex flex-col items-center gap-6">
              <div className="w-32 h-32 rounded-2xl bg-white/10 flex items-center justify-center">
                <Icon className={cn('h-16 w-16', typeConfig.color)} />
              </div>
              <p className="text-sm text-white/80 font-medium">{file.name}</p>
              <audio src={file.url!} controls className="w-full max-w-md" />
            </div>
          )}

          {isPdf && (
            <iframe
              src={file.url!}
              className="w-full h-full rounded-lg border border-white/10 shadow-[0_8px_36px_rgba(0,0,0,0.14)]"
              title={file.name}
            />
          )}

          {!isImage && !isVideo && !isAudio && !isPdf && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-24 h-24 rounded-2xl bg-white/10 flex items-center justify-center">
                <Icon className={cn('h-12 w-12', typeConfig.color)} />
              </div>
              <div>
                <p className="text-sm font-medium text-white">{file.name}</p>
                <p className="text-xs text-white/50 mt-1 capitalize">{t.welddrive.filePreview.unsupported.fileLabel.replace('{fileType}', file.fileType)}</p>
                {file.fileSize !== null && (
                  <p className="text-xs text-white/50 mt-0.5">{formatFileSize(file.fileSize)}</p>
                )}
              </div>
              {(file.source === 'drive' || file.url) && (
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => downloadFile(file)}>
                  <Download className="h-4 w-4 mr-1.5" />
                  {t.welddrive.filePreview.unsupported.download}
                </Button>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Bottom Zoom Controls (for images) */}
      {isImage && (
        <div className="relative z-10 flex items-center justify-center h-16">
          <div className="flex items-center gap-3">
            <PreviewTooltip label={t.welddrive.filePreview.tooltips.zoomOut}>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-30"
                onClick={handleZoomOut}
                disabled={zoom <= 0.25}
              >
                <Minus className="size-5" />
              </Button>
            </PreviewTooltip>
            <span className="text-sm text-white/70 w-14 text-center select-none">{zoomPercent}%</span>
            <PreviewTooltip label={t.welddrive.filePreview.tooltips.zoomIn}>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-30"
                onClick={handleZoomIn}
                disabled={zoom >= 5}
              >
                <Plus className="size-5" />
              </Button>
            </PreviewTooltip>
            <div className="w-px h-5 bg-white/20" />
            <PreviewTooltip label={t.welddrive.filePreview.tooltips.rotate}>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10"
                onClick={handleRotate}
              >
                <RotateCwSquare className="size-5" />
              </Button>
            </PreviewTooltip>
            <PreviewTooltip label={t.welddrive.filePreview.tooltips.fitToScreen}>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-[10px] text-white/70 hover:text-white hover:bg-white/10"
                onClick={handleFitToScreen}
              >
                <Fullscreen className="size-5" />
              </Button>
            </PreviewTooltip>
          </div>
        </div>
      )}
    </div>
  );
}

