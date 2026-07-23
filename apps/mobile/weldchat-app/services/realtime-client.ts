/**
 * Realtime config for the WeldChat mobile app.
 *
 * Workspace-level events use the single shared WorkspaceClient owned by
 * <RealtimeProvider> (packages/core/realtime/react) — consumed via useTopic /
 * useChatUserEvents. Per-channel RoomClient instances are created in
 * useChatRealtime using the base URL below.
 */

const REALTIME_URL =
  process.env.EXPO_PUBLIC_REALTIME_URL || 'ws://localhost:8790';

export function getRealtimeBaseUrl(): string {
  return REALTIME_URL;
}
