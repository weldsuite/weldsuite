/**
 * Realtime config for the WeldChat mobile app.
 *
 * Workspace-level events use the single shared WorkspaceClient owned by
 * <RealtimeProvider> (packages/core/realtime/react) — consumed via useTopic /
 * useChatUserEvents. Per-channel RoomClient instances are created in
 * useChatRealtime using the base URL below.
 */

import { realtimeUrl } from '@weldsuite/mobile-platform/api';

/** The booted server's realtime base URL (without `/ws`); read per call, never at import time. */
export function getRealtimeBaseUrl(): string {
  return realtimeUrl();
}
