import { useRouterState } from '@tanstack/react-router';
import { fromPreviewPath, usePreviewMode } from '@/contexts/preview-mode-context';

/**
 * Compat layer: drop-in replacement for `usePathname()` from `next/navigation`.
 * Returns the current pathname string.
 */
export function usePathname(): string {
  const previewMode = usePreviewMode();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return fromPreviewPath(previewMode, pathname);
}
