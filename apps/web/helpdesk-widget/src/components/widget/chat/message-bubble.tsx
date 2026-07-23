/**
 * Message Bubble Component
 * Displays individual messages from user or agent
 * Click to show sender info and timestamp
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Markdown from 'react-markdown';
import { FileText, X, Download } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { Message, MessageAttachment } from '@/lib/api/types';

// Helper to check if attachment is an image
function isImageAttachment(attachment: MessageAttachment): boolean {
  // Check mimeType first (from API)
  if (attachment.mimeType?.startsWith('image/')) return true;
  // Fall back to type field
  if (attachment.type === 'image') return true;
  // Check file extension as last resort
  const name = attachment.fileName || attachment.name || '';
  const ext = name.split('.').pop()?.toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext || '');
}

// Helper to format file size
function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface MessageBubbleProps {
  message: Message;
  isGrouped?: boolean;
  isFirstMessage?: boolean;
  isLastAgentMessage?: boolean;
  themeSettings?: {
    userBubbleColor?: string;
    userBubbleTextColor?: string;
    agentBubbleColor?: string;
    agentBubbleTextColor?: string;
  };
}

export function MessageBubble({ message, isGrouped = false, isFirstMessage = false, isLastAgentMessage = false, themeSettings }: MessageBubbleProps) {
  const isUser = message.sender === 'user';
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef({ isDragging: false, startX: 0, startY: 0, lastX: 0, lastY: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const isEmbedded = typeof window !== 'undefined' && window.self !== window.top;

  const resetZoom = useCallback(() => {
    setZoomScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const openImageFullScreen = (url: string) => {
    if (isEmbedded) {
      const parentOrigin = new URLSearchParams(window.location.search).get('parentOrigin') || '*';
      window.parent.postMessage({ type: 'weld:image:open', url }, parentOrigin);
    } else {
      resetZoom();
      setViewingImage(url);
    }
  };

  const closeLightbox = useCallback(() => {
    setViewingImage(null);
    resetZoom();
  }, [resetZoom]);

  // Close lightbox on Escape key (standalone mode only)
  useEffect(() => {
    if (!viewingImage) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [viewingImage, closeLightbox]);

  // Mouse wheel zoom
  useEffect(() => {
    if (!viewingImage) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoomScale(prev => {
        const next = Math.min(Math.max(prev + (e.deltaY > 0 ? -0.25 : 0.25), 1), 5);
        if (next === 1) setTranslate({ x: 0, y: 0 });
        return next;
      });
    };
    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => document.removeEventListener('wheel', handleWheel);
  }, [viewingImage]);

  // Drag-to-pan handlers
  useEffect(() => {
    if (!viewingImage) return;
    const handleMouseMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d.isDragging) return;
      setTranslate({ x: d.lastX + (e.clientX - d.startX), y: d.lastY + (e.clientY - d.startY) });
    };
    const handleMouseUp = () => { dragRef.current.isDragging = false; };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [viewingImage]);

  const isStreaming = message.metadata?.isStreaming === true;
  const hasAttachments = message.attachments && message.attachments.length > 0;
  const hasContent = (message.content && message.content.trim().length > 0) || isStreaming;

  // Format relative time for last agent message
  const relativeTime = useMemo(() => {
    if (!isLastAgentMessage || isUser) return null;
    const now = Date.now();
    const ts = new Date(message.timestamp).getTime();
    const diffMins = Math.floor((now - ts) / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins === 1) return '1 min ago';
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    return `${diffDays} days ago`;
  }, [isLastAgentMessage, isUser, message.timestamp]);

  const senderName = useMemo(() => {
    if (!isLastAgentMessage || isUser) return null;
    return message.senderName || 'AI Agent';
  }, [isLastAgentMessage, isUser, message.senderName]);

  const isFailed = isUser && !!(message.metadata as Record<string, unknown> | undefined)?.sendFailed;

  return (
    <div
      className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}
      style={{
        marginTop: isFirstMessage ? '0px' : (isGrouped ? '4px' : '12px'),
        opacity: isFailed ? 0.6 : 1,
      }}
    >
      {/* Attachments */}
      {hasAttachments && (
        <div className={cn(
          'flex flex-wrap gap-2 mb-2 max-w-[85%]',
          isUser ? 'justify-end' : 'justify-start'
        )}>
          {message.attachments!.map(attachment => {
            const fileName = attachment.fileName || attachment.name || 'File';
            const fileSize = attachment.fileSize || (attachment.size ? parseInt(attachment.size) : undefined);

            return isImageAttachment(attachment) && attachment.url ? (
              <img
                key={attachment.id}
                src={attachment.url}
                alt={fileName}
                onClick={() => openImageFullScreen(attachment.url!)}
                className="max-h-48 max-w-full rounded-lg border border-gray-200 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                onError={(e) => {
                  // If image fails to load, hide it
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <a
                key={attachment.id}
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                download={fileName}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                  isUser
                    ? 'bg-gray-800 hover:bg-gray-700'
                    : 'bg-gray-100 hover:bg-gray-200'
                )}
              >
                <FileText className={cn(
                  'h-4 w-4 flex-shrink-0',
                  isUser ? 'text-gray-400' : 'text-gray-500'
                )} />
                <div className="min-w-0 flex-1">
                  <p className={cn(
                    'truncate max-w-[150px]',
                    isUser ? 'text-white' : 'text-gray-700'
                  )}>{fileName}</p>
                  {fileSize && (
                    <p className={cn(
                      'text-xs',
                      isUser ? 'text-gray-400' : 'text-gray-500'
                    )}>{formatFileSize(fileSize)}</p>
                  )}
                </div>
                <Download className={cn(
                  'h-4 w-4 flex-shrink-0',
                  isUser ? 'text-gray-400' : 'text-gray-500'
                )} />
              </a>
            );
          })}
        </div>
      )}

      {/* Message content */}
      {hasContent && (
        <div
          className="max-w-[85%] px-4 py-3 rounded-2xl"
          style={{
            backgroundColor: isUser
              ? (themeSettings?.userBubbleColor || '#000000')
              : (themeSettings?.agentBubbleColor || '#F5F5F5'),
            color: isUser
              ? (themeSettings?.userBubbleTextColor || '#FFFFFF')
              : (themeSettings?.agentBubbleTextColor || '#000000'),
            borderTopRightRadius: isUser && isGrouped ? '4px' : '16px',
            borderBottomRightRadius: isUser ? '4px' : '16px',
            borderTopLeftRadius: !isUser && isGrouped ? '4px' : '16px',
            borderBottomLeftRadius: !isUser ? '4px' : '16px',
          }}
        >
          <div className="text-sm leading-relaxed break-words">
            <Markdown
              components={{
                a: ({ children, href }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className={cn('underline hover:opacity-70', isUser ? 'text-white' : 'text-black')}>
                    {children}
                  </a>
                ),
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc pl-4 mb-2 last:mb-0">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 last:mb-0">{children}</ol>,
                li: ({ children }) => <li className="mb-0.5">{children}</li>,
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                h1: ({ children }) => <p className="font-semibold mb-1">{children}</p>,
                h2: ({ children }) => <p className="font-semibold mb-1">{children}</p>,
                h3: ({ children }) => <p className="font-semibold mb-1">{children}</p>,
                code: ({ children }) => (
                  <code className={cn('rounded px-1 py-0.5 text-xs', isUser ? 'bg-white/15' : 'bg-black/10')}>{children}</code>
                ),
                pre: ({ children }) => (
                  <pre className={cn('rounded p-2 text-xs overflow-x-auto mb-2 last:mb-0', isUser ? 'bg-white/15' : 'bg-black/10')}>{children}</pre>
                ),
              }}
            >
              {message.content}
            </Markdown>
            {isStreaming && (
              <span
                className="inline-block w-0.5 h-4 ml-0.5 align-middle"
                style={{
                  backgroundColor: isUser
                    ? (themeSettings?.userBubbleTextColor || '#FFFFFF')
                    : (themeSettings?.agentBubbleTextColor || '#000000'),
                  animation: 'streamingCursor 1s ease-in-out infinite',
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* Send failure indicator */}
      {isFailed && (
        <p className="text-xs text-red-500 mt-1 pr-1">
          Failed to send
        </p>
      )}

      {/* Sender name & time — last agent message only */}
      {isLastAgentMessage && !isUser && relativeTime && (
        <p className="text-xs text-gray-400 mt-1 pl-1">
          {relativeTime}
        </p>
      )}

      {/* Image Lightbox (standalone mode only) */}
      {viewingImage && (
        <div
          className="fixed inset-0 z-[99999] bg-black/90 flex items-center justify-center p-4 overflow-hidden"
          onClick={() => { if (zoomScale <= 1) closeLightbox(); }}
        >
          <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
            <a
              href={viewingImage}
              download
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            >
              <Download className="h-6 w-6 text-white" />
            </a>
            <button
              onClick={(e) => { e.stopPropagation(); closeLightbox(); }}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            >
              <X className="h-6 w-6 text-white" />
            </button>
          </div>
          <img
            ref={imgRef}
            src={viewingImage}
            alt="Full size"
            draggable={false}
            className="max-w-full max-h-full object-contain rounded-lg select-none"
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${zoomScale})`,
              transition: dragRef.current.isDragging ? 'none' : 'transform 0.2s ease',
              cursor: zoomScale > 1 ? 'zoom-out' : 'zoom-in',
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (zoomScale === 1) {
                const rect = (e.target as HTMLImageElement).getBoundingClientRect();
                const clickX = e.clientX - rect.left - rect.width / 2;
                const clickY = e.clientY - rect.top - rect.height / 2;
                setZoomScale(2.5);
                setTranslate({ x: -clickX * 1.5, y: -clickY * 1.5 });
              } else {
                resetZoom();
              }
            }}
            onMouseDown={(e) => {
              if (zoomScale <= 1) return;
              e.preventDefault();
              dragRef.current = { isDragging: true, startX: e.clientX, startY: e.clientY, lastX: translate.x, lastY: translate.y };
            }}
          />
        </div>
      )}
    </div>
  );
}
