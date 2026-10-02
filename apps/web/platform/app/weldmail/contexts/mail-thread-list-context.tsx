import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ThreadSummary } from '../lib/thread-utils';
import type { ThreadListLocation } from '../lib/next-thread';
import type { ThreadRef } from '../lib/optimistic-thread-list';

interface MailThreadListContextValue extends ThreadListLocation {
  threads: ThreadSummary[];
  hideThread: (current: ThreadRef) => void;
  unhideThread: (current: ThreadRef) => void;
}

const noop = () => {};

const MailThreadListContext = createContext<MailThreadListContextValue | null>(null);

export function MailThreadListProvider({
  threads,
  isUnified,
  folder,
  accountId,
  hideThread = noop,
  unhideThread = noop,
  children,
}: Omit<MailThreadListContextValue, 'hideThread' | 'unhideThread'> & {
  hideThread?: MailThreadListContextValue['hideThread'];
  unhideThread?: MailThreadListContextValue['unhideThread'];
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ threads, isUnified, folder, accountId, hideThread, unhideThread }),
    [threads, isUnified, folder, accountId, hideThread, unhideThread],
  );
  return (
    <MailThreadListContext.Provider value={value}>
      {children}
    </MailThreadListContext.Provider>
  );
}

export function useMailThreadListSafe() {
  return useContext(MailThreadListContext);
}
