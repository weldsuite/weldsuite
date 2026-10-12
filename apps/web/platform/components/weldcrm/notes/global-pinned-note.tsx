
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, StickyNote, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePinnedNote, type PinnedNote } from '@/contexts/pinned-note-context';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { MINIMIZED_DOCK_ROOM, MinimizedDockButton, minimizedDockRight } from '@/components/shared/minimized-dock-button';
import { MinimizedDockGroup, useMinimizedDockAllowed, useMinimizedDockOccupied } from '@/components/shared/minimized-dock';
import { getNoteTitle } from './note-title';
import { useTranslations } from '@weldsuite/i18n/client';
import { NOTE_POPUP_FRAME } from './note-popup-frame';
import type { NoteEditorSurfaceHandle } from './note-editor-surface';

// The editor is the same surface the Notes page popup renders. It is loaded
// only once a note is pinned: this component sits in the app shell on every
// page, and the block editor is far too heavy to ship with it.
const NoteEditorSurface = lazy(() =>
  import('./note-editor-surface').then((m) => ({ default: m.NoteEditorSurface })),
);
// The centred popup, for a note maximized on a page other than Notes.
const NotePopupDialog = lazy(() =>
  import('./note-popup-dialog').then((m) => ({ default: m.NotePopupDialog })),
);

// A pinned note always arrives with its save handler; this only keeps the
// surface's `onSave` stable if it ever does not.
const NO_SAVE = async () => {};

/**
 * Whether the panel is minimized, and how. Taken from the context the moment
 * a note is pinned, while rendering rather than in an effect: an effect runs
 * after the first paint, so a note sent here minimized showed the open panel
 * for a frame and then shrank.
 */
function useMinimizedState(openNote: PinnedNote | null, startMinimized: boolean) {
  const [isMinimized, setIsMinimized] = useState(false);
  // Where the note was minimized from, which is where its button reopens it:
  // the centred popup, or this panel.
  const [minimizedFrom, setMinimizedFrom] = useState<'dialog' | 'panel'>('panel');
  const [minimizedTitle, setMinimizedTitle] = useState('');

  const [syncedNote, setSyncedNote] = useState<PinnedNote | null>(null);
  if (openNote !== syncedNote) {
    setSyncedNote(openNote);
    if (openNote) {
      setIsMinimized(startMinimized);
      setMinimizedFrom(startMinimized ? 'dialog' : 'panel');
      setMinimizedTitle(getNoteTitle(openNote.content));
    }
  }

  // Minimized from the panel itself, so its button reopens the panel.
  const minimize = (title: string) => {
    setMinimizedTitle(title);
    setMinimizedFrom('panel');
    setIsMinimized(true);
  };
  const restore = () => setIsMinimized(false);

  return { isMinimized, minimizedFrom, minimizedTitle, minimize, restore };
}

/**
 * The pinned note: a small panel in the bottom-right corner that stays on
 * screen across pages. It is the note popup's `NoteEditorSurface` in its
 * compact size, in a fixed frame instead of a dialog and without a backdrop,
 * since the page behind stays in use.
 *
 * Minimized, it is the round dock button a minimized mail is
 * (`MinimizedDockButton`); the panel stays mounted but hidden behind it, so
 * the editor keeps what was typed.
 */
export function GlobalPinnedNote() {
  const t = useTranslations();
  const { pinnedNote, isOpen, onSave, closePinnedNote, unpinToDialog, unpinnedNote, unpinnedNoteSave, unpinnedNoteDelete, clearUnpinnedNote, startMinimized, setStartMinimized } = usePinnedNote();

  const surfaceRef = useRef<NoteEditorSurfaceHandle>(null);
  const openNote = pinnedNote && isOpen ? pinnedNote : null;
  const { isMinimized, minimizedFrom, minimizedTitle, minimize, restore } = useMinimizedState(openNote, startMinimized);
  const mobileNav = useMobileNavOptional();
  const dockAllowed = useMinimizedDockAllowed();
  const dockOccupied = useMinimizedDockOccupied();

  // The flag is one-shot: clear it once this open has consumed it. Excludes
  // startMinimized/setStartMinimized on purpose, so it fires once per open
  // and not again when clearing the flag changes the value being read.
  useEffect(() => {
    if (pinnedNote && isOpen) setStartMinimized(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedNote, isOpen]);

  // Only render on client
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  // Unpinned on a page other than Notes, which is not there to show its
  // popup: show the same popup from here.
  if (unpinnedNote) {
    return (
      <Suspense fallback={null}>
        <NotePopupDialog
          note={unpinnedNote}
          open={true}
          onOpenChange={(open) => { if (!open) clearUnpinnedNote(); }}
          onSave={unpinnedNoteSave ?? NO_SAVE}
          onDelete={unpinnedNoteDelete ?? clearUnpinnedNote}
        />
      </Suspense>
    );
  }

  if (!pinnedNote || !isOpen) return null;

  // Back to the centred dialog, with what the panel holds right now.
  const handleUnpin = () => {
    const content = surfaceRef.current?.getContent();
    void surfaceRef.current?.flushSave();
    unpinToDialog(content);
  };

  const handleClose = () => {
    void surfaceRef.current?.flushSave();
    closePinnedNote();
  };

  const handleMinimize = () => {
    minimize(getNoteTitle(surfaceRef.current?.getContent() ?? pinnedNote.content));
  };

  const RecordIcon = pinnedNote.recordKind === 'person' ? User : Building2;

  const panel = (
    <>
      {/* Minimized: the note's group in the dock, above any minimized mails. */}
      {isMinimized && dockAllowed && (
        <MinimizedDockGroup kind="note" testId="pinned-note-minimized">
          <MinimizedDockButton
            label={minimizedTitle === 'Untitled' ? t('sweep.weldcrm.globalPinnedNote.untitled') : minimizedTitle}
            icon={<StickyNote className="size-4 text-foreground" />}
            avatarUrl={pinnedNote.recordAvatar}
            avatarAlt={pinnedNote.recordName}
            avatarFallback={<RecordIcon className="size-2 text-muted-foreground" />}
            onOpen={minimizedFrom === 'dialog' ? handleUnpin : restore}
            onDismiss={handleClose}
            openLabel={t('sweep.weldcrm.globalPinnedNote.expand')}
            dismissLabel={t('sweep.weldcrm.globalPinnedNote.close')}
            testId="pinned-note-minimized-btn"
          />
        </MinimizedDockGroup>
      )}
      <div
        className={cn(
          "bg-background fixed z-50 p-0 flex flex-col gap-0 rounded-lg",
          "bottom-4",
          NOTE_POPUP_FRAME,
          isMinimized && "hidden"
        )}
        // What is minimized (mails) keeps the corner; the panel sits beside it.
        style={{
          right: dockOccupied && dockAllowed ? `calc(${minimizedDockRight(mobileNav)} + ${MINIMIZED_DOCK_ROOM})` : '16px',
          width: '440px',
          maxWidth: '90vw',
          height: '500px',
          maxHeight: '90vh',
        }}
      >
        <Suspense fallback={null}>
          <NoteEditorSurface
            ref={surfaceRef}
            note={pinnedNote}
            active={isOpen}
            onSave={onSave ?? NO_SAVE}
            size="compact"
            visible={!isMinimized}
            pinTitle={t('sweep.weldcrm.globalPinnedNote.unpin')}
            onMinimize={handleMinimize}
            onPinToggle={handleUnpin}
            onClose={handleClose}
          />
        </Suspense>
      </div>
    </>
  );

  return createPortal(panel, document.body);
}
