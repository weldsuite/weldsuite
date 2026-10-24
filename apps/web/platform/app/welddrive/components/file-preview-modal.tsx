import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Download,
  ExternalLink,
  FileSpreadsheet,
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
  Loader2,
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
import { createPortal } from 'react-dom';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { canOpenInWeldSheets, fileTypeIcons, sourceBadgeStyles, driveLabelClass, formatFileSize, formatDate, downloadFile, fetchDriveFileContent } from './drive-file-card';
import { useOpenInWeldSheets } from '@/app/weldsheets/use-sheet-files';
import { driveSourceKey, driveSourceLabel, fileKindLabel, isTextPreviewable } from './drive-utils';
import { cn } from '@/lib/utils';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { copyText } from '@/lib/clipboard';

/** Text files bigger than this are not read for the preview. */
const TEXT_PREVIEW_MAX_FILE_SIZE = 5 * 1024 * 1024;
/** How much of a text file the preview shows. */
const TEXT_PREVIEW_LIMIT = 512 * 1024;

type TextPreviewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; text: string; truncated: boolean };

/** A plain-text file read through the content endpoint; `fallback` when it can't be read. */
function TextPreview({ file, fallback }: Readonly<{ file: UnifiedFile; fallback: React.ReactNode }>) {
  const { t } = useI18n();
  const [state, setState] = useState<TextPreviewState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchDriveFileContent(file.id, controller.signal)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        const truncated = bytes.byteLength > TEXT_PREVIEW_LIMIT;
        const text = new TextDecoder().decode(truncated ? bytes.slice(0, TEXT_PREVIEW_LIMIT) : bytes);
        setState({ status: 'ready', text, truncated });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [file.id]);

  if (state.status === 'error') return <>{fallback}</>;
  if (state.status === 'loading') {
    return <Loader2 className="h-6 w-6 animate-spin text-white/60" />;
  }
  return (
    <div className="pointer-events-auto flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-background text-foreground shadow-[0_8px_36px_rgba(0,0,0,0.14)]">
      <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words p-6 font-mono text-[13px] leading-relaxed">
        {state.text}
      </pre>
      {state.truncated && (
        <p className="border-t border-border px-6 py-2 text-xs text-muted-foreground">
          {t.welddrive.filePreview.textTruncated}
        </p>
      )}
    </div>
  );
}

function PreviewTooltip({ label, children, side = 'top' }: Readonly<{ label: string; children: React.ReactNode; side?: 'top' | 'bottom' }>) {
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
      role="presentation"
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
  onShare?: (file: UnifiedFile) => void;
}

export function FilePreviewModal({ file, open, onClose, onNext, onPrevious, onToggleStar, onMoveToFolder, onRename, onCopyLink, onDelete, onShare }: Readonly<FilePreviewModalProps>) {
  const { t } = useI18n();
  const openInSheets = useOpenInWeldSheets();
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
        // A menu, popover or dialog on top (the preview's own menus, Rename,
        // Move to trash) closes first: Radix marks the Escape it handled.
        if (e.defaultPrevented) return;
        if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
        onClose();
        return;
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
  const badgeClass = sourceBadgeStyles[driveSourceKey(file)] || sourceBadgeStyles.drive;

  const isImage = file.fileType === 'image' && file.url;
  const isVideo = (file.fileType === 'video' || (file.fileType === 'recording' && file.mimeType?.startsWith('video/'))) && file.url;
  const isAudio = (file.fileType === 'audio' || (file.fileType === 'recording' && !file.mimeType?.startsWith('video/'))) && file.url;
  const isPdf = file.fileType === 'pdf' && file.url;
  const isText = !isImage && !isVideo && !isAudio && !isPdf
    && isTextPreviewable(file) && (file.fileSize ?? 0) <= TEXT_PREVIEW_MAX_FILE_SIZE;

  const zoomPercent = Math.round(zoom * 100);

  const unsupportedPreview = (
    <div className="pointer-events-auto flex flex-col items-center gap-4 text-center">
      <div className="w-24 h-24 rounded-2xl bg-white/10 flex items-center justify-center">
        <Icon className={cn('h-12 w-12', typeConfig.color)} />
      </div>
      <div>
        <p className="text-sm font-medium text-white">{file.name}</p>
        <p className="text-xs text-white/50 mt-1">{fileKindLabel(file, t)}</p>
        {file.fileSize !== null && (
          <p className="text-xs text-white/50 mt-0.5">{formatFileSize(file.fileSize)}</p>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        {openInSheets && canOpenInWeldSheets(file) && (
          <Button size="sm" variant="secondary" onClick={() => void openInSheets(file)}>
            <FileSpreadsheet className="h-4 w-4 mr-1.5" />
            {t.welddrive.page.actions.openInWeldSheets}
          </Button>
        )}
        {(file.source === 'drive' || file.url) && (
          <Button size="sm" variant="secondary" onClick={() => downloadFile(file)}>
            <Download className="h-4 w-4 mr-1.5" />
            {t.welddrive.filePreview.unsupported.download}
          </Button>
        )}
      </div>
    </div>
  );

  // Rendered on <body>: inside the page it sat under the app rail, whose
  // home link then took the clicks meant for the close button.
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col">
      {/* Backdrop */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/80" onClick={onClose} />

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
                    {driveSourceLabel(file, t)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2 py-1.5 text-sm">
                  <span className="text-muted-foreground">{t.welddrive.filePreview.details.modified}</span>
                  <span className="tabular-nums">{formatDate(file.createdAt)}</span>
                </div>
                {file.updatedAt && (
                  <div className="flex items-center justify-between px-2 py-1.5 text-sm">
                    <span className="text-muted-foreground">{t.welddrive.filePreview.details.updated}</span>
                    <span className="tabular-nums">{formatDate(file.updatedAt)}</span>
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
                {openInSheets && canOpenInWeldSheets(file) && (
                  <DropdownMenuItem onClick={() => void openInSheets(file)}>
                    <FileSpreadsheet className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.openInWeldSheets}
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
                    copyText(file.url);
                  }
                }}>
                  <Link className="h-4 w-4 mr-0.5" />
                  {t.welddrive.filePreview.actions.copyLink}
                </DropdownMenuItem>
                {onShare && (
                  <DropdownMenuItem onClick={() => onShare(file)}>
                    <UserPlus className="h-4 w-4 mr-0.5" />
                    {t.welddrive.filePreview.actions.share}
                  </DropdownMenuItem>
                )}
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
        <div className="flex-1 overflow-auto">
          <div className="relative h-full w-full">
            {/* Backdrop: clicking the empty area closes the preview. The content sits above it and
                only lets the media, the file panels and the controls receive pointer events. */}
            <button
              type="button"
              tabIndex={-1}
              aria-label={t.welddrive.filePreview.tooltips.close}
              className="absolute inset-0 cursor-default"
              onClick={onClose}
            />
            <div className="pointer-events-none relative flex h-full w-full items-center justify-center p-8 [&_audio]:pointer-events-auto [&_button]:pointer-events-auto [&_iframe]:pointer-events-auto [&_img]:pointer-events-auto [&_video]:pointer-events-auto">
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
                <div className="pointer-events-auto flex flex-col items-center gap-6">
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

              {isText && <TextPreview key={file.id} file={file} fallback={unsupportedPreview} />}

              {!isImage && !isVideo && !isAudio && !isPdf && !isText && unsupportedPreview}
            </div>
          </div>
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
    </div>,
    document.body,
  );
}

