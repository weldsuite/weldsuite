import { FileText } from 'lucide-react';
import type { MessageAttachment } from '@/lib/api/types';
import { isImageAttachment, safeHref } from '@/lib/utils/attachments';
import { cn } from '@/lib/utils/cn';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Files on a message: images as thumbnails linking to the full file, everything else as a file link. */
export function MessageAttachments({
  attachments,
  className,
}: Readonly<{ attachments: MessageAttachment[]; className?: string }>) {
  const items = attachments.flatMap((attachment) => {
    const href = safeHref(attachment.url);
    return href ? [{ attachment, href }] : [];
  });
  if (items.length === 0) return null;

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid="message-attachments">
      {items.map(({ attachment, href }) =>
        isImageAttachment(attachment.contentType) ? (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded-lg"
            data-testid="attachment-image"
          >
            <img
              src={href}
              alt={attachment.name}
              loading="lazy"
              className="max-h-48 max-w-full rounded-lg object-cover"
            />
          </a>
        ) : (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg bg-black/5 px-2 py-1.5 text-xs underline-offset-2 hover:underline"
            data-testid="attachment-file"
          >
            <FileText className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 truncate">{attachment.name}</span>
            <span className="flex-shrink-0 opacity-70">{formatSize(attachment.filesize)}</span>
          </a>
        ),
      )}
    </div>
  );
}
