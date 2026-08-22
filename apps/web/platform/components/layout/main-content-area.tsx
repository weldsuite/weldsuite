
import { ReactNode } from 'react';

interface MainContentAreaProps {
  children: ReactNode;
  /** Fixed-height embedded shell (help doc screenshots). */
  embedded?: boolean;
}

export function MainContentArea({ children, embedded }: MainContentAreaProps) {
  return (
    <div
      className={
        embedded
          ? 'ml-16 h-full overflow-hidden'
          : 'ml-0 md:ml-16 h-screen pt-14 md:pt-0 overflow-hidden'
      }
    >
      {children}
    </div>
  );
}
