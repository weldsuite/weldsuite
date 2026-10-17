
import { ReactNode } from 'react';

interface MainContentAreaProps {
  children: ReactNode;
  /** Fixed-height embedded shell (help doc screenshots). */
  embedded?: boolean;
}

export function MainContentArea({ children, embedded }: Readonly<MainContentAreaProps>) {
  return (
    <div
      className={
        embedded
          ? 'ml-15 h-full overflow-hidden'
          : 'ml-0 md:ml-15 h-screen pt-14 md:pt-0 overflow-hidden'
      }
    >
      {children}
    </div>
  );
}
