
import { ReactNode } from 'react';

interface MainContentAreaProps {
  children: ReactNode;
}

export function MainContentArea({ children }: MainContentAreaProps) {
  return (
    <div className="ml-0 md:ml-16 h-screen pt-14 md:pt-0 overflow-hidden">
      {children}
    </div>
  );
}
