/** Small pieces shared by the My HR pages. */

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

/** Centered spinner for a section (or a card inside one) that is still loading. */
export function TabLoading() {
  return (
    <div className="flex justify-center py-10">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  );
}

/** A leave type / balance colour dot. Falls back to a neutral grey. */
export function ColorDot({ color }: Readonly<{ color: string | null }>) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color ?? '#94a3b8' }} />;
}

/** Muted one-liner under a row title. */
export function Meta({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
