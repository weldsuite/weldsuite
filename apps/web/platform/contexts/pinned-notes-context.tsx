
import React, { createContext, useContext, useState, useMemo, useCallback, ReactNode } from 'react';

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  isFavorite?: boolean;
  linkedCompany?: {
    id: string;
    name: string;
    logoUrl?: string;
    color?: string;
  };
  author?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
}

interface PinnedNote extends Note {
  position?: { x: number; y: number };
  isMinimized?: boolean;
}

interface PinnedNotesContextType {
  pinnedNotes: PinnedNote[];
  addPinnedNote: (note: Note) => void;
  removePinnedNote: (noteId: string) => void;
  updatePinnedNote: (noteId: string, updates: Partial<PinnedNote>) => void;
  toggleMinimize: (noteId: string) => void;
}

const PinnedNotesContext = createContext<PinnedNotesContextType | undefined>(undefined);

export function PinnedNotesProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [pinnedNotes, setPinnedNotes] = useState<PinnedNote[]>([]);

  const addPinnedNote = useCallback((note: Note) => {
    // Add note with default position (bottom right corner with padding),
    // unless it is already pinned
    setPinnedNotes(prev => prev.some(n => n.id === note.id) ? prev : [...prev, {
      ...note,
      position: { x: Math.max(20, window.innerWidth - 430), y: Math.max(20, window.innerHeight - 350) },
      isMinimized: false
    }]);
  }, []);

  const removePinnedNote = useCallback((noteId: string) => {
    setPinnedNotes(prev => prev.filter(note => note.id !== noteId));
  }, []);

  const updatePinnedNote = useCallback((noteId: string, updates: Partial<PinnedNote>) => {
    setPinnedNotes(prev => prev.map(note =>
      note.id === noteId ? { ...note, ...updates } : note
    ));
  }, []);

  const toggleMinimize = useCallback((noteId: string) => {
    setPinnedNotes(prev => prev.map(note =>
      note.id === noteId ? { ...note, isMinimized: !note.isMinimized } : note
    ));
  }, []);

  const value = useMemo(
    () => ({
      pinnedNotes,
      addPinnedNote,
      removePinnedNote,
      updatePinnedNote,
      toggleMinimize
    }),
    [pinnedNotes, addPinnedNote, removePinnedNote, updatePinnedNote, toggleMinimize]
  );

  return (
    <PinnedNotesContext.Provider value={value}>
      {children}
    </PinnedNotesContext.Provider>
  );
}

export function usePinnedNotes() {
  const context = useContext(PinnedNotesContext);
  if (context === undefined) {
    throw new Error('usePinnedNotes must be used within a PinnedNotesProvider');
  }
  return context;
}