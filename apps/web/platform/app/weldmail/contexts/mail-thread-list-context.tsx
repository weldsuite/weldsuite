import { createContext, useContext, type ReactNode } from 'react';
import type { ThreadSummary } from '../lib/thread-utils';
import type { ThreadListLocation } from '../lib/next-thread';

interface MailThreadListContextValue extends ThreadListLocation {
  threads: ThreadSummary[];
}

const MailThreadListContext = createContext<MailThreadListContextValue | null>(null);

export function MailThreadListProvider({
  threads,
  isUnified,
  folder,
  accountId,
  children,
}: MailThreadListContextValue & { children: ReactNode }) {
  return (
    <MailThreadListContext.Provider value={{ threads, isUnified, folder, accountId }}>
      {children}
    </MailThreadListContext.Provider>
  );
}

export function useMailThreadListSafe() {
  return useContext(MailThreadListContext);
}
