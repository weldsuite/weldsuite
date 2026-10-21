
import { createContext, useContext, useState, ReactNode, useCallback, useMemo } from 'react';
import { offerDraftHandoff, type DraftAutosaver } from '@/app/weldmail/lib/draft-autosave';

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

/** A mail put aside as a small button; several can wait next to each other. */
export interface MinimizedCompose {
  id: string;
  data: ComposeData;
  /** Keeps the mail's draft, so reopening it continues that draft. */
  saver: DraftAutosaver | null;
}

interface ComposeContextType {
  isComposeOpen: boolean;
  composeData: ComposeData;
  /** Changes with every mail the floating panel opens, so it starts each one clean. */
  composeSession: number;
  minimizedComposes: MinimizedCompose[];
  /** Puts a mail aside; the surface it was in closes itself. */
  minimizeCompose: (data: ComposeData, saver: DraftAutosaver | null) => void;
  /** Opens a minimized mail in the floating panel again. */
  restoreMinimized: (id: string) => void;
  /** Drops a minimized mail; what was written stays behind as its draft. */
  dismissMinimized: (id: string) => void;
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

/**
 * Provides the compose state, unless an outer ComposeProvider already does: a
 * module layout (WeldMail, WeldDesk) then shares the app shell's, so a mail
 * opened in one module and expanded to WeldMail's full-page compose keeps what
 * was written. `panel` (the floating compose) renders only where this provider
 * is the one in charge, so there is never a second panel on the same state.
 */
export function ComposeProvider({ children, panel }: Readonly<{ children: ReactNode; panel?: ReactNode }>) {
  const outer = useContext(ComposeContext);
  if (outer) return <>{children}</>;
  return (
    <RootComposeProvider>
      {children}
      {panel}
    </RootComposeProvider>
  );
}

function RootComposeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeData, setComposeData] = useState<ComposeData>(defaultComposeData);
  const [previousUrlState, setPreviousUrlState] = useState<string | null>(null);
  const [composeSession, setComposeSession] = useState(0);
  const [minimizedComposes, setMinimizedComposes] = useState<MinimizedCompose[]>([]);

  const openCompose = useCallback((data?: Partial<ComposeData>, fromUrl?: string) => {
    if (fromUrl) {
      setPreviousUrlState(fromUrl);
    }
    setComposeData({ ...defaultComposeData, ...data });
    setIsComposeOpen(true);
    setComposeSession((session) => session + 1);
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
    setComposeSession((session) => session + 1);
  }, []);

  const minimizeCompose = useCallback((data: ComposeData, saver: DraftAutosaver | null) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setMinimizedComposes((prev) => [...prev, { id, data, saver }]);
  }, []);

  const restoreMinimized = useCallback(
    (id: string) => {
      const entry = minimizedComposes.find((compose) => compose.id === id);
      if (!entry) return;
      setMinimizedComposes((prev) => prev.filter((compose) => compose.id !== id));
      // The panel picks the saver up when it opens, and goes on with the same draft.
      if (entry.saver && !entry.saver.isClosed) offerDraftHandoff(entry.saver, entry.data.accountId);
      setComposeData({ ...defaultComposeData, ...entry.data });
      setIsComposeOpen(true);
      setComposeSession((session) => session + 1);
    },
    [minimizedComposes],
  );

  const dismissMinimized = useCallback(
    (id: string) => {
      const entry = minimizedComposes.find((compose) => compose.id === id);
      setMinimizedComposes((prev) => prev.filter((compose) => compose.id !== id));
      void entry?.saver?.finish();
    },
    [minimizedComposes],
  );

  const setPreviousUrl = useCallback((url: string) => {
    setPreviousUrlState(url);
  }, []);

  const value = useMemo(
    () => ({
      isComposeOpen,
      composeData,
      composeSession,
      minimizedComposes,
      minimizeCompose,
      restoreMinimized,
      dismissMinimized,
      previousUrl: previousUrlState,
      openCompose,
      closeCompose,
      updateComposeData,
      minimizeToPanel,
      setPreviousUrl
    }),
    [
      isComposeOpen, composeData, composeSession, minimizedComposes, minimizeCompose, restoreMinimized,
      dismissMinimized, previousUrlState, openCompose, closeCompose, updateComposeData,
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
