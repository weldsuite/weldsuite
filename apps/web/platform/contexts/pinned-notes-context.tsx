
import React, { createContext, useContext, useState, ReactNode } from 'react';

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

function PinnedNotesProvider({ children }: { children: ReactNode }) {
  const [pinnedNotes, setPinnedNotes] = useState<PinnedNote[]>([]);

  const addPinnedNote = (note: Note) => {
    // Check if already pinned
    if (pinnedNotes.find(n => n.id === note.id)) return;
    
    // Add note with default position (bottom right corner with padding)
    setPinnedNotes(prev => [...prev, {
      ...note,
      position: { x: Math.max(20, window.innerWidth - 430), y: Math.max(20, window.innerHeight - 350) },
      isMinimized: false
    }]);
  };

  const removePinnedNote = (noteId: string) => {
    setPinnedNotes(prev => prev.filter(note => note.id !== noteId));
  };

  const updatePinnedNote = (noteId: string, updates: Partial<PinnedNote>) => {
    setPinnedNotes(prev => prev.map(note => 
      note.id === noteId ? { ...note, ...updates } : note
    ));
  };

  const toggleMinimize = (noteId: string) => {
    setPinnedNotes(prev => prev.map(note => 
      note.id === noteId ? { ...note, isMinimized: !note.isMinimized } : note
    ));
  };

  return (
    <PinnedNotesContext.Provider value={{
      pinnedNotes,
      addPinnedNote,
      removePinnedNote,
      updatePinnedNote,
      toggleMinimize
    }}>
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