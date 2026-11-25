import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, FileIcon, Download, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ClipPlayer } from './clip-player';
import type { ChatClipAttachment } from '@weldsuite/db/schema';
import { useTranslations } from '@weldsuite/i18n/client';

interface FilePreviewProps {
  attachment: {
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
    thumbnailUrl?: string;
    [key: string]: unknown;
  };
  channelId?: string;
  messageId?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/** One image the lightbox can step to. */
interface GalleryImage {
  url: string;
  fileName: string;
}

/**
 * The images of the conversation the clicked thumbnail sits in, in the order
 * they show (inline images, galleries and forwards alike), and where the clicked
 * one is. A conversation's list marks itself `data-chat-image-scope`, so the main
 * list and an open thread each page through their own images; a thumbnail
 * outside one (a pinned message) shows just itself.
 */
function galleryFrom(trigger: HTMLElement): { images: GalleryImage[]; index: number } {
  const scope = trigger.closest('[data-chat-image-scope]');
  const thumbnails = scope ? Array.from(scope.querySelectorAll<HTMLElement>('[data-chat-image-url]')) : [trigger];
  const images = thumbnails.map((el) => ({ url: el.dataset.chatImageUrl ?? '', fileName: el.dataset.chatImageName ?? '' }));
  return { images, index: Math.max(0, thumbnails.indexOf(trigger)) };
}

function inferClipType(
  attachment: FilePreviewProps['attachment'],
): ChatClipAttachment['clipType'] | null {
  if (
    'clipType' in attachment &&
    (attachment.clipType === 'audio' ||
      attachment.clipType === 'video' ||
      attachment.clipType === 'screen')
  ) {
    return attachment.clipType;
  }
  // Fallback for attachments that lost clipType (e.g. older messages) or
  // mobile uploads that only set an audio/* MIME type.
  if (attachment.mimeType.startsWith('audio/')) return 'audio';
  if (attachment.mimeType.startsWith('video/')) return 'video';
  return null;
}

export function FilePreview({ attachment, channelId, messageId }: Readonly<FilePreviewProps>) {
  const t = useTranslations();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const thumbnailRef = useRef<HTMLButtonElement>(null);
  const [gallery, setGallery] = useState<{ images: GalleryImage[]; index: number }>({ images: [], index: 0 });
  const shown = gallery.images[gallery.index] ?? { url: attachment.url, fileName: attachment.fileName };
  const hasPrevious = gallery.index > 0;
  const hasNext = gallery.index < gallery.images.length - 1;

  // Fetch the neighbours while this one is on screen, so stepping to them shows them at once.
  useEffect(() => {
    if (!lightboxOpen) return;
    for (const neighbour of [gallery.images[gallery.index - 1], gallery.images[gallery.index + 1]]) {
      if (neighbour) new Image().src = neighbour.url;
    }
  }, [lightboxOpen, gallery]);

  function openLightbox() {
    setGallery(thumbnailRef.current ? galleryFrom(thumbnailRef.current) : { images: [], index: 0 });
    setLightboxOpen(true);
  }

  function step(direction: -1 | 1) {
    setGallery((current) => {
      const index = current.index + direction;
      return index < 0 || index >= current.images.length ? current : { ...current, index };
    });
  }

  function onLightboxKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  const clipType = inferClipType(attachment);
  if (clipType) {
    const clipAttachment: ChatClipAttachment = {
      id: attachment.id,
      fileName: attachment.fileName,
      fileSize: attachment.fileSize,
      mimeType: attachment.mimeType,
      url: attachment.url,
      thumbnailUrl: attachment.thumbnailUrl,
      clipType,
      durationSeconds:
        typeof attachment.durationSeconds === 'number' ? attachment.durationSeconds : 0,
      transcript: attachment.transcript as ChatClipAttachment['transcript'],
    };
    return <ClipPlayer attachment={clipAttachment} channelId={channelId} messageId={messageId} />;
  }

  const isImage = attachment.mimeType.startsWith('image/');

  if (isImage) {
    return (
      <>
        <Button
          ref={thumbnailRef}
          type="button"
          variant="ghost"
          onClick={openLightbox}
          // Read by the lightbox to page through the conversation's images.
          data-chat-image-url={attachment.url}
          data-chat-image-name={attachment.fileName}
          className="block h-auto max-w-[300px] rounded-lg overflow-hidden border hover:opacity-90 transition cursor-zoom-in p-0"
        >
          <img
            src={attachment.thumbnailUrl || attachment.url}
            alt={attachment.fileName}
            className="max-h-[200px] object-cover"
          />
        </Button>
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent
            showCloseButton={false}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onLightboxKeyDown}
            className="group max-w-none w-screen h-screen sm:max-w-none rounded-none border-0 bg-black/95 p-0 gap-0 grid-rows-[1fr] flex items-center justify-center duration-200 ease-out data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100"
          >
            <DialogTitle className="absolute top-4 left-4 z-10 text-white text-sm font-normal max-w-[60vw] truncate group-data-[state=open]:animate-in group-data-[state=closed]:animate-out group-data-[state=open]:fade-in-0 group-data-[state=closed]:fade-out-0 duration-200 ease-out">
              {shown.fileName}
              {gallery.images.length > 1 && (
                <span className="ml-2 text-white/60 tabular-nums">
                  {t('sweep.weldchat.filePreview.position', { current: gallery.index + 1, total: gallery.images.length })}
                </span>
              )}
            </DialogTitle>

            <Button
              type="button"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxOpen(false);
              }}
              aria-label={t('sweep.weldchat.filePreview.closePreview')}
              // A click anywhere beside the image closes it. `h-full w-full` beat the button's own `h-9`,
              // which left this a 36px strip at the top; no hover tint over the whole screen.
              className="absolute inset-0 h-full w-full cursor-zoom-out rounded-none p-0 hover:bg-transparent dark:hover:bg-transparent"
            />

            <img
              src={shown.url}
              alt={shown.fileName}
              className="relative max-h-[90vh] max-w-[90vw] object-contain rounded shadow-2xl group-data-[state=open]:animate-in group-data-[state=closed]:animate-out group-data-[state=open]:fade-in-0 group-data-[state=closed]:fade-out-0 group-data-[state=open]:zoom-in-95 group-data-[state=closed]:zoom-out-95 duration-200 ease-out"
            />

            {/* Previous and next image of the conversation; the arrow keys do the same. */}
            {hasPrevious && (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute left-4 top-1/2 z-10 h-11 w-11 -translate-y-1/2 rounded-full border-0 bg-white/10 text-white hover:bg-white/20"
                onClick={(e) => {
                  e.stopPropagation();
                  step(-1);
                }}
                aria-label={t('sweep.weldchat.filePreview.previous')}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
            )}
            {hasNext && (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute right-4 top-1/2 z-10 h-11 w-11 -translate-y-1/2 rounded-full border-0 bg-white/10 text-white hover:bg-white/20"
                onClick={(e) => {
                  e.stopPropagation();
                  step(1);
                }}
                aria-label={t('sweep.weldchat.filePreview.next')}
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            )}

            <div className="absolute top-4 right-4 flex items-center gap-2 z-10 group-data-[state=open]:animate-in group-data-[state=closed]:animate-out group-data-[state=open]:fade-in-0 group-data-[state=closed]:fade-out-0 duration-200 ease-out">
              <Button
                variant="secondary"
                size="icon"
                className="h-9 w-9 bg-white/10 hover:bg-white/20 text-white border-0"
                asChild
                onClick={(e) => e.stopPropagation()}
              >
                <a
                  href={shown.url}
                  download={shown.fileName}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('sweep.weldchat.filePreview.download')}
                >
                  <Download className="h-4 w-4" />
                </a>
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className="h-9 w-9 bg-white/10 hover:bg-white/20 text-white border-0"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxOpen(false);
                }}
                aria-label={t('sweep.weldchat.filePreview.close')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border max-w-[300px]">
      <FileIcon className="h-8 w-8 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{attachment.fileName}</p>
        <p className="text-xs text-muted-foreground">
          {formatFileSize(attachment.fileSize)}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 flex-shrink-0"
        asChild
      >
        <a href={attachment.url} download={attachment.fileName}>
          <Download className="h-4 w-4" />
        </a>
      </Button>
    </div>
  );
}
