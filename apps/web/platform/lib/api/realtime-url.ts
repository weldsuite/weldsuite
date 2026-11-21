/**
 * The URL of a realtime socket (`/ws`, `/ws/chat/:id`, `/ws/conversation/:id`, …).
 *
 * In membership mode (OIDC with `auth.workspaceSource: "header"`) the session
 * token names no workspace: API requests carry it in `X-Weld-Workspace`
 * (`./workspace-header.ts`), but a browser can't set a header on a WebSocket,
 * so the socket names it in its URL, `?workspace=<workspaces.id>`, and the
 * gateway checks the membership (`rust/crates/realtime/src/workspace.rs`).
 * Everywhere else `getActiveWorkspaceId()` is null and the URL is unchanged.
 */

import { getActiveWorkspaceId } from '@/lib/auth';
import { getRealtimeWsOrigin } from '@/lib/api/public-env';

/** The query parameter a socket names its workspace in. */
export const REALTIME_WORKSPACE_PARAM = 'workspace';

/**
 * The socket URL for `path` on the realtime gateway, or `''` when this
 * deployment has no realtime (callers then open no socket).
 */
export function realtimeSocketUrl(path: `/ws${string}`): string {
  const origin = getRealtimeWsOrigin();
  if (!origin) return '';
  const url = new URL(`${origin}${path}`);
  const workspaceId = getActiveWorkspaceId();
  if (workspaceId) url.searchParams.set(REALTIME_WORKSPACE_PARAM, workspaceId);
  return url.toString();
}
