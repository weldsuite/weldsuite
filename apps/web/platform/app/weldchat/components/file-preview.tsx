import { useState } from 'react';
import { FileIcon, Download, X } from 'lucide-react';
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
    [key: string]: any;
  };
  channelId?: string;
  messageId?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export function FilePreview({ attachment, channelId, messageId }: FilePreviewProps) {
  const t = useTranslations();
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Clip attachment
  if ('clipType' in attachment && attachment.clipType) {
    return <ClipPlayer attachment={attachment as ChatClipAttachment} channelId={channelId} messageId={messageId} />;
  }

  const isImage = attachment.mimeType.startsWith('image/');

  if (isImage) {
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setLightboxOpen(true)}
          className="block max-w-[300px] rounded-lg overflow-hidden border hover:opacity-90 transition cursor-zoom-in p-0"
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
            className="group max-w-none w-screen h-screen sm:max-w-none rounded-none border-0 bg-black/95 p-0 gap-0 grid-rows-[1fr] flex items-center justify-center duration-200 ease-out data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100"
          >
            <DialogTitle className="absolute top-4 left-4 z-10 text-white text-sm font-normal max-w-[60vw] truncate group-data-[state=open]:animate-in group-data-[state=closed]:animate-out group-data-[state=open]:fade-in-0 group-data-[state=closed]:fade-out-0 duration-200 ease-out">
              {attachment.fileName}
            </DialogTitle>

            <Button
              type="button"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxOpen(false);
              }}
              aria-label={t('sweep.weldchat.filePreview.closePreview')}
              className="absolute inset-0 cursor-zoom-out rounded-none p-0"
            />

            <img
              src={attachment.url}
              alt={attachment.fileName}
              onClick={(e) => e.stopPropagation()}
              className="relative max-h-[90vh] max-w-[90vw] object-contain rounded shadow-2xl group-data-[state=open]:animate-in group-data-[state=closed]:animate-out group-data-[state=open]:fade-in-0 group-data-[state=closed]:fade-out-0 group-data-[state=open]:zoom-in-95 group-data-[state=closed]:zoom-out-95 duration-200 ease-out"
            />

            <div className="absolute top-4 right-4 flex items-center gap-2 z-10 group-data-[state=open]:animate-in group-data-[state=closed]:animate-out group-data-[state=open]:fade-in-0 group-data-[state=closed]:fade-out-0 duration-200 ease-out">
              <Button
                variant="secondary"
                size="icon"
                className="h-9 w-9 bg-white/10 hover:bg-white/20 text-white border-0"
                asChild
                onClick={(e) => e.stopPropagation()}
              >
                <a
                  href={attachment.url}
                  download={attachment.fileName}
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
