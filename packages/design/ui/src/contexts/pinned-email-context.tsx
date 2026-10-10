'use client';

import { createContext, useContext, useState, useMemo, useCallback, ReactNode } from 'react';

interface EmailData {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  showCc: boolean;
  showBcc: boolean;
}

interface PinnedEmailContextType {
  isPinned: boolean;
  emailData: EmailData | null;
  pinEmail: (data: EmailData) => void;
  unpinEmail: () => void;
  updateEmailData: (data: Partial<EmailData>) => void;
}

const PinnedEmailContext = createContext<PinnedEmailContextType | undefined>(undefined);

export function PinnedEmailProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [isPinned, setIsPinned] = useState(false);
  const [emailData, setEmailData] = useState<EmailData | null>(null);

  const pinEmail = useCallback((data: EmailData) => {
    setEmailData(data);
    setIsPinned(true);
  }, []);

  const unpinEmail = useCallback(() => {
    setIsPinned(false);
    // Keep email data for potential re-pinning
  }, []);

  const updateEmailData = useCallback((data: Partial<EmailData>) => {
    setEmailData(prev => (prev ? { ...prev, ...data } : prev));
  }, []);

  const value = useMemo(
    () => ({
      isPinned,
      emailData,
      pinEmail,
      unpinEmail,
      updateEmailData,
    }),
    [isPinned, emailData, pinEmail, unpinEmail, updateEmailData]
  );

  return (
    <PinnedEmailContext.Provider value={value}>
      {children}
    </PinnedEmailContext.Provider>
  );
}

export function usePinnedEmail() {
  const context = useContext(PinnedEmailContext);
  if (context === undefined) {
    throw new Error('usePinnedEmail must be used within a PinnedEmailProvider');
  }
  return context;
}