import { useCallback, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { usePinnedNote, type PinnedNote } from '@/contexts/pinned-note-context';
import { NoteEditorSurface, type NoteEditorSurfaceHandle } from './note-editor-surface';
import { NOTE_POPUP_FRAME } from './note-popup-frame';

/**
 * The centred note popup: a dialog around the shared `NoteEditorSurface`.
 * Minimizing or pinning hands the note to the global pinned panel
 * (`GlobalPinnedNote`), which renders the same surface in its compact size.
 * The Notes page opens it, and so does the pinned note when it is maximized
 * on any other page.
 */
export function NotePopupDialog({
  note,
  open,
  onOpenChange,
  onSave,
  onDelete,
  recordAvatar,
}: Readonly<{
  note: PinnedNote | null;
  /** The record's image, looked up by the page; a separate prop so a late
      arrival does not hand the editor a new `note`. */
  recordAvatar?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (content: string) => Promise<void>;
  onDelete: () => void;
}>) {
  const t = useTranslations();
  const { setPinnedNote, setIsOpen: setGlobalPinnedOpen, setOnSave, setOnDelete, setStartMinimized } = usePinnedNote();
  const surfaceRef = useRef<NoteEditorSurfaceHandle>(null);
  const [isTransitioningToPin, setIsTransitioningToPin] = useState(false);

  // Transfer to the global pinned note, so it persists across pages.
  const pinToGlobal = useCallback(
    (minimized: boolean) => {
      if (!note) return;
      const content = surfaceRef.current?.getContent() ?? note.content;
      void surfaceRef.current?.flushSave();
      setStartMinimized(minimized);
      setIsTransitioningToPin(true);
      setPinnedNote({ ...note, content, recordAvatar: note.recordAvatar || recordAvatar });
      setOnSave(onSave);
      setOnDelete(onDelete);
      setGlobalPinnedOpen(true);
      // Close dialog after a frame so opacity-0 renders first (avoids shrink animation)
      requestAnimationFrame(() => {
        onOpenChange(false);
        // Reset after dialog is closed
        setTimeout(() => setIsTransitioningToPin(false), 0);
      });
    },
    [note, recordAvatar, onSave, onDelete, setPinnedNote, setOnSave, setOnDelete, setGlobalPinnedOpen, setStartMinimized, onOpenChange],
  );

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) void surfaceRef.current?.flushSave();
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        {/* The stock dimmed backdrop. The pinned panel has none: it stays on
            screen while the page behind is in use. */}
        {!isTransitioningToPin && <DialogOverlay />}
        <DialogPrimitive.Content
          className={cn(
            "bg-background fixed z-50 rounded-lg p-0 flex flex-col gap-0 transition-all duration-200",
            NOTE_POPUP_FRAME,
            isTransitioningToPin ? "opacity-0 pointer-events-none" : "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            // Centred with auto margins, not `translate(-50%, -50%)`: the popup
            // is 935px tall, so half of it is a half pixel, and a translated
            // box is not snapped to the pixel grid. Every 1px line in it (the
            // one under the header first) was drawn blurred across two pixels
            // on a 1x screen.
            "inset-0 m-auto",
          )}
          style={{ width: '890px', maxWidth: '90vw', height: '935px', maxHeight: '90vh' }}
        >
          <NoteEditorSurface
            ref={surfaceRef}
            note={note}
            active={open}
            recordAvatar={recordAvatar}
            onSave={onSave}
            titleSlot={<DialogTitle className="sr-only">{t('sweep.weldcrm.noteEditorDialog.editNote')}</DialogTitle>}
            pinTitle={t('sweep.weldcrm.noteEditorDialog.pinToScreen')}
            onMinimize={() => pinToGlobal(true)}
            onPinToggle={() => pinToGlobal(false)}
            onClose={() => handleOpenChange(false)}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
