import { createContext, useContext } from 'react';

/** The editor's scrolled page area, for what lines up with the pages from beside them (the comments). */
export interface DocScroll {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Room to add under the last page, for comment cards that run past it. */
  setRoomBelow: (px: number) => void;
}

export const DocScrollContext = createContext<DocScroll | null>(null);

export function useDocScroll(): DocScroll | null {
  return useContext(DocScrollContext);
}
