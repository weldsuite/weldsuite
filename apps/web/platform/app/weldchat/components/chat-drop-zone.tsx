import { useCallback, type ReactNode } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';

interface ChatDropZoneProps {
  channelId: string;
  /** Optional parent message id when wrapping a thread composer. */
  parentId?: string | null;
  children: ReactNode;
}

/**
 * Wraps the chat surface and turns it into a file drop target using
 * `react-dropzone` — the same primitive the shadcn `Dropzone` component
 * (apps/web/platform/components/ui/dropzone.tsx) wraps. We can't use that
 * component directly here because it renders as a `<Button>`; the chat
 * surface needs to stay fully interactive while still accepting drops.
 *
 * Dropped files are dispatched as a `weldchat:dropped-files` window event
 * with the channel + thread context so the matching MessageInput picks
 * them up via its existing presign → PUT → confirm upload flow.
 */
export function ChatDropZone({ channelId, parentId, children }: ChatDropZoneProps) {
  const t = getTranslations('weldchat');
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted.length === 0) return;
      window.dispatchEvent(
        new CustomEvent('weldchat:dropped-files', {
          detail: { channelId, parentId: parentId ?? null, files: accepted },
        }),
      );
    },
    [channelId, parentId],
  );

  const { getRootProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    multiple: true,
  });

  return (
    <div
      {...getRootProps({
        className: 'relative flex-1 min-h-0 flex flex-col',
      })}
    >
      {children}
      {isDragActive && (
        <div
          className={cn(
            'pointer-events-none absolute inset-2 z-30 rounded-xl bg-background/85 backdrop-blur-[2px]',
            'flex flex-col items-center justify-center gap-2.5 text-center text-gray-500 dark:text-gray-400',
          )}
          aria-hidden
        >
          {/* Inline SVG outline — `currentColor` picks up the parent's text
              color and the dasharray gives a clearly dashed look that CSS
              `border-style: dashed` doesn't render well at 0.5px. */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="absolute inset-0 h-full w-full overflow-visible"
            preserveAspectRatio="none"
          >
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              rx="12"
              ry="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.5"
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* Matches the DropzoneEmptyState markup in
              apps/web/platform/components/ui/dropzone.tsx so the visual reads
              identically to the shadcn dropzone. */}
          <div className="relative flex items-center justify-center text-muted-foreground">
            <UploadIcon className="size-7" />
          </div>
          <div className="relative flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">{t.dropZone.uploadFile}</p>
            <p className="text-muted-foreground text-xs">
              {t.dropZone.dropToAttach}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
