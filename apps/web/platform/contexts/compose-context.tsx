
import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

interface ComposeData {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  attachedFiles?: File[];
  scheduledTime?: Date | null;
  inReplyTo?: string;
  accountId?: string;
}

interface ComposeContextType {
  isComposeOpen: boolean;
  composeData: ComposeData;
  previousUrl: string | null;
  openCompose: (data?: Partial<ComposeData>, fromUrl?: string) => void;
  closeCompose: () => void;
  updateComposeData: (data: Partial<ComposeData>) => void;
  minimizeToPanel: (data: ComposeData) => void;
  setPreviousUrl: (url: string) => void;
}

const defaultComposeData: ComposeData = {
  to: '',
  subject: '',
  body: '',
  cc: '',
  bcc: '',
  attachedFiles: [],
  scheduledTime: null,
};

const ComposeContext = createContext<ComposeContextType | undefined>(undefined);

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeData, setComposeData] = useState<ComposeData>(defaultComposeData);
  const [previousUrl, setPreviousUrlState] = useState<string | null>(null);

  const openCompose = useCallback((data?: Partial<ComposeData>, fromUrl?: string) => {
    if (fromUrl) {
      setPreviousUrlState(fromUrl);
    }
    setComposeData({ ...defaultComposeData, ...data });
    setIsComposeOpen(true);
  }, []);

  const closeCompose = useCallback(() => {
    setIsComposeOpen(false);
    setComposeData(defaultComposeData);
  }, []);

  const updateComposeData = useCallback((data: Partial<ComposeData>) => {
    setComposeData(prev => ({ ...prev, ...data }));
  }, []);

  const minimizeToPanel = useCallback((data: ComposeData) => {
    setComposeData(data);
    setIsComposeOpen(true);
  }, []);

  const setPreviousUrl = useCallback((url: string) => {
    setPreviousUrlState(url);
  }, []);

  return (
    <ComposeContext.Provider value={{
      isComposeOpen,
      composeData,
      previousUrl,
      openCompose,
      closeCompose,
      updateComposeData,
      minimizeToPanel,
      setPreviousUrl
    }}>
      {children}
    </ComposeContext.Provider>
  );
}

function useCompose() {
  const context = useContext(ComposeContext);
  if (context === undefined) {
    throw new Error('useCompose must be used within a ComposeProvider');
  }
  return context;
}

export function useComposeSafe() {
  return useContext(ComposeContext);
}
