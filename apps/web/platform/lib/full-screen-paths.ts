/**
 * Workspace pages that are full-screen tools: the app shell renders them
 * without its sidebar and global overlays, but still behind the post-trial
 * paywall (`components/app-shell-client.tsx`). They bring their own top bar.
 */

import { stripWorkspacePrefix } from '@/lib/workspace-url';

const FULL_SCREEN_WORKSPACE_PATHS: readonly RegExp[] = [
  // The online store editor (WeldCommerce).
  /^\/weldcommerce\/online-store\/[^/]+\/editor\/?$/,
];

export function isFullScreenWorkspacePath(pathname: string): boolean {
  const path = stripWorkspacePrefix(pathname);
  return FULL_SCREEN_WORKSPACE_PATHS.some((pattern) => pattern.test(path));
}
