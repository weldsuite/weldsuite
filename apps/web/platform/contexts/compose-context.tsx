
import { createContext, useContext, useState, ReactNode, useCallback, useMemo } from 'react';

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

export function ComposeProvider({ children }: Readonly<{ children: ReactNode }>) {
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

  const value = useMemo(
    () => ({
      isComposeOpen,
      composeData,
      previousUrl,
      openCompose,
      closeCompose,
      updateComposeData,
      minimizeToPanel,
      setPreviousUrl
    }),
    [
      isComposeOpen, composeData, previousUrl, openCompose, closeCompose, updateComposeData,
      minimizeToPanel, setPreviousUrl,
    ]
  );

  return (
    <ComposeContext.Provider value={value}>
      {children}
    </ComposeContext.Provider>
  );
}

export function useComposeSafe() {
  return useContext(ComposeContext);
}
