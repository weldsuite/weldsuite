import { useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { parseWorkspacePath, workspacePath } from '@/lib/workspace-url';

/**
 * Absolute links into this tab's workspace (FE-013): `{origin}/w/{slug}{path}`.
 *
 * For links that leave the tab: Stripe and OAuth return URLs, and links
 * people copy. A full-page return or a link opened elsewhere loads the
 * platform in the session's last active workspace; the `/w/` prefix brings it
 * back to the one the link was made in. A path that already names its
 * workspace is kept as it is. Without an active workspace this is the bare
 * `{origin}{path}`.
 */
export function useWorkspaceUrl(): (path: string) => string {
  const { orgSlug, orgId } = useAuth();
  const ref = orgSlug || orgId;
  return useCallback(
    (path: string) => {
      const named = !ref || parseWorkspacePath(path.split(/[?#]/, 1)[0]) !== null;
      return `${window.location.origin}${named ? path : workspacePath(ref, path)}`;
    },
    [ref],
  );
}
