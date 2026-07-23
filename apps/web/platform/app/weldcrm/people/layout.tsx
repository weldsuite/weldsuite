import { ReactNode } from 'react';

/**
 * People module layout. Thin wrapper — rich detail tabs land in Phase 9.
 */
export default function PeopleLayout({ children }: { children: ReactNode }) {
  return <div className="flex flex-col h-full">{children}</div>;
}
