import { useCallback, type ReactNode } from 'react';
import { DropArea, DropAreaOverlay } from '@weldsuite/ui/components/drop-area';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';

interface ChatDropZoneProps {
  channelId: string;
  /** Optional parent message id when wrapping a thread composer. */
  parentId?: string | null;
  /**
   * Who or where the files go, shown as "Upload to …": "#general", a DM's
   * person, a group's name. Left out, the overlay says "Upload files".
   */
  targetName?: string | null;
  /** Classes for the wrapper, which is the drop target and fills its slot. */
  className?: string;
  children: ReactNode;
}

/**
 * A conversation (header, messages and composer) as a file drop target: the
 * library's `DropArea`, which turns the conversation into a dashed "Upload to
 * …" area while files are dragged over it, as WhatsApp does.
 *
 * Dropped files are dispatched as a `weldchat:dropped-files` window event
 * with the channel + thread context so the matching MessageInput picks
 * them up via its existing presign → PUT → confirm upload flow, and they wait
 * in the composer so a message can go with them. The composer's attach button
 * stays the way to add files by keyboard or screen reader.
 */
export function ChatDropZone({ channelId, parentId, targetName, className, children }: Readonly<ChatDropZoneProps>) {
  const t = getTranslations('weldchat');
  const onDrop = useCallback(
    (files: File[]) => {
      window.dispatchEvent(
        new CustomEvent('weldchat:dropped-files', {
          detail: { channelId, parentId: parentId ?? null, files },
        }),
      );
    },
    [channelId, parentId],
  );

  return (
    <DropArea onDrop={onDrop} className={cn('flex-1 min-h-0 flex flex-col', className)}>
      {children}
      {/* WhatsApp-style: a dashed border with one centred line naming where the files go. */}
      <DropAreaOverlay title={targetName ? t.dropZone.uploadTo.replace('{name}', targetName) : t.dropZone.uploadFile} />
    </DropArea>
  );
}
