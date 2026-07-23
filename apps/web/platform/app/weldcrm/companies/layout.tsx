import { ReactNode } from 'react';

/**
 * Companies module layout. Thin wrapper — list and detail pages slot into the
 * dashboard layout via the parent route. Kept simple while detail tabs are
 * still being wired up in Phase 9 (cross-module rewrites).
 */
export default function CompaniesLayout({ children }: { children: ReactNode }) {
  return <div className="flex flex-col h-full">{children}</div>;
}
