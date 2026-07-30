/**
 * useEntityEvents — stubs after migration to @weldsuite/realtime.
 *
 * Realtime entity events should use useTopic / useRealtimeEvent from
 * @weldsuite/realtime. These stubs preserve the call-site signatures so the
 * platform builds while that migration happens.
 */

import type { AnyPlatformEvent } from '@/lib/platform-events/types';

interface UseEntityEventsOptions {
  entityType: string;
  entityId?: string;
  onCreated?: (event: AnyPlatformEvent) => void;
  onUpdated?: (event: AnyPlatformEvent) => void;
  onDeleted?: (event: AnyPlatformEvent) => void;
  onArchived?: (event: AnyPlatformEvent) => void;
  onAny?: (event: AnyPlatformEvent) => void;
  skipOwnEvents?: boolean;
}
type EntityEventHandlers = Omit<UseEntityEventsOptions, 'entityType'>;export function useTaskEvents(_options: EntityEventHandlers = {}): void {}export function useProjectMemberEvents(_options: EntityEventHandlers = {}): void {}
export function useProjectMessageEvents(_options: EntityEventHandlers = {}): void {}