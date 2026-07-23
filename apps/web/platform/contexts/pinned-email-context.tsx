
import { createContext, useContext, useState, ReactNode } from 'react';

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

export function PinnedEmailProvider({ children }: { children: ReactNode }) {
  const [isPinned, setIsPinned] = useState(false);
  const [emailData, setEmailData] = useState<EmailData | null>(null);

  const pinEmail = (data: EmailData) => {
    setEmailData(data);
    setIsPinned(true);
  };

  const unpinEmail = () => {
    setIsPinned(false);
    // Keep email data for potential re-pinning
  };

  const updateEmailData = (data: Partial<EmailData>) => {
    if (emailData) {
      setEmailData({ ...emailData, ...data });
    }
  };

  return (
    <PinnedEmailContext.Provider value={{ isPinned, emailData, pinEmail, unpinEmail, updateEmailData }}>
      {children}
    </PinnedEmailContext.Provider>
  );
}

function usePinnedEmail() {
  const context = useContext(PinnedEmailContext);
  if (context === undefined) {
    throw new Error('usePinnedEmail must be used within a PinnedEmailProvider');
  }
  return context;
}
