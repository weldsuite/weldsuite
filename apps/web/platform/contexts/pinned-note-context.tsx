
import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

interface Note {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  isPinned?: boolean;
  recordKind?: 'company' | 'person';
  recordId?: string;
  recordName?: string;
  recordAvatar?: string;
  authorName?: string;
}

interface PinnedNoteContextType {
  pinnedNote: Note | null;
  setPinnedNote: (note: Note | null) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  onSave: ((content: string) => Promise<void>) | null;
  setOnSave: (fn: ((content: string) => Promise<void>) | null) => void;
  onDelete: (() => void) | null;
  setOnDelete: (fn: (() => void) | null) => void;
  onUnpin: ((note: Note) => void) | null;
  setOnUnpin: (fn: ((note: Note) => void) | null) => void;
  startMinimized: boolean;
  setStartMinimized: (minimized: boolean) => void;
  closePinnedNote: () => void;
  unpinToDialog: () => void;
  // Note that was unpinned but has no page handler — shown in a fallback dialog
  unpinnedNote: Note | null;
  unpinnedNoteSave: ((content: string) => Promise<void>) | null;
  unpinnedNoteDelete: (() => void) | null;
  setUnpinnedNote: (note: Note | null) => void;
  clearUnpinnedNote: () => void;
}

const PinnedNoteContext = createContext<PinnedNoteContextType | null>(null);

export function PinnedNoteProvider({ children }: { children: ReactNode }) {
  const [pinnedNote, setPinnedNote] = useState<Note | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [onSave, setOnSave] = useState<((content: string) => Promise<void>) | null>(null);
  const [onDelete, setOnDelete] = useState<(() => void) | null>(null);
  const [onUnpin, setOnUnpinState] = useState<((note: Note) => void) | null>(null);
  const [startMinimized, setStartMinimized] = useState(false);
  const [unpinnedNote, setUnpinnedNote] = useState<Note | null>(null);
  const [unpinnedNoteSave, setUnpinnedNoteSave] = useState<((content: string) => Promise<void>) | null>(null);
  const [unpinnedNoteDelete, setUnpinnedNoteDelete] = useState<(() => void) | null>(null);

  const clearUnpinnedNote = useCallback(() => {
    setUnpinnedNote(null);
    setUnpinnedNoteSave(null);
    setUnpinnedNoteDelete(null);
  }, []);

  const setOnUnpin = useCallback((fn: ((note: Note) => void) | null) => {
    setOnUnpinState(() => fn);
  }, []);

  const closePinnedNote = useCallback(() => {
    setPinnedNote(null);
    setIsOpen(false);
    setOnSave(null);
    setOnDelete(null);
  }, []);

  const unpinToDialog = useCallback(() => {
    if (!pinnedNote) return;
    const note = pinnedNote;
    const saveFn = onSave;
    const deleteFn = onDelete;
    setPinnedNote(null);
    setIsOpen(false);
    setOnSave(null);
    setOnDelete(null);

    if (onUnpin) {
      // Notes page is mounted — let it handle showing the dialog
      onUnpin(note);
    } else {
      // On a different page — show the same NoteEditorDialog via fallback
      setUnpinnedNote(note);
      setUnpinnedNoteSave(() => saveFn);
      setUnpinnedNoteDelete(() => deleteFn);
    }
  }, [pinnedNote, onUnpin, onSave, onDelete]);

  return (
    <PinnedNoteContext.Provider
      value={{
        pinnedNote,
        setPinnedNote,
        isOpen,
        setIsOpen,
        onSave,
        setOnSave: (fn) => setOnSave(() => fn),
        onDelete,
        setOnDelete: (fn) => setOnDelete(() => fn),
        onUnpin,
        setOnUnpin,
        startMinimized,
        setStartMinimized,
        closePinnedNote,
        unpinToDialog,
        unpinnedNote,
        unpinnedNoteSave,
        unpinnedNoteDelete,
        setUnpinnedNote,
        clearUnpinnedNote,
      }}
    >
      {children}
    </PinnedNoteContext.Provider>
  );
}

export function usePinnedNote() {
  const context = useContext(PinnedNoteContext);
  if (!context) {
    throw new Error('usePinnedNote must be used within a PinnedNoteProvider');
  }
  return context;
}
