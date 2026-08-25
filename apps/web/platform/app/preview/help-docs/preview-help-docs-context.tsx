'use client';

import { createContext, useContext, type ReactNode } from 'react';

export interface PreviewHelpDocsUiState {
  /** Open the DNS tab add-record form on first paint (help-doc screenshots). */
  initialShowAddRecord?: boolean;
}

const PreviewHelpDocsContext = createContext<PreviewHelpDocsUiState | null>(null);

export function PreviewHelpDocsProvider({
  value,
  children,
}: {
  value: PreviewHelpDocsUiState;
  children: ReactNode;
}) {
  return (
    <PreviewHelpDocsContext.Provider value={value}>
      {children}
    </PreviewHelpDocsContext.Provider>
  );
}

export function usePreviewHelpDocsUiState() {
  return useContext(PreviewHelpDocsContext);
}
