import { usePathname } from '@/lib/router';

/**
 * Whether the current route is a detail page below `basePath`
 * (`/welddesk/tickets/tk_123` under `/welddesk/tickets`). Feeds
 * `ListDetailLayout`'s `isDetailSelected`, which shows either the list or the
 * detail pane on small screens.
 */
export function useIsDetailSelected(basePath: string): boolean {
  const pathname = usePathname();
  return pathname !== basePath && pathname.startsWith(basePath);
}
