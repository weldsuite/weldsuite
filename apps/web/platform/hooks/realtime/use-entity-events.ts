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

function useEntityEvents(_options: UseEntityEventsOptions): void {}

type EntityEventHandlers = Omit<UseEntityEventsOptions, 'entityType'>;

function useProjectEvents(_options: EntityEventHandlers = {}): void {}
export function useTaskEvents(_options: EntityEventHandlers = {}): void {}
function useContactEvents(_options: EntityEventHandlers = {}): void {}
function useCompanyEvents(_options: EntityEventHandlers = {}): void {}
function useLeadEvents(_options: EntityEventHandlers = {}): void {}
function useOpportunityEvents(_options: EntityEventHandlers = {}): void {}
function useInventoryEvents(_options: EntityEventHandlers = {}): void {}
function useInvoiceEvents(_options: EntityEventHandlers = {}): void {}
function useBillEvents(_options: EntityEventHandlers = {}): void {}
function usePaymentEvents(_options: EntityEventHandlers = {}): void {}
function useTicketEvents(_options: EntityEventHandlers = {}): void {}
function useNotificationEvents(_options: EntityEventHandlers = {}): void {}
export function useProjectMemberEvents(_options: EntityEventHandlers = {}): void {}
export function useProjectMessageEvents(_options: EntityEventHandlers = {}): void {}
function useProjectDocumentEvents(_options: EntityEventHandlers = {}): void {}
function useProjectFileEvents(_options: EntityEventHandlers = {}): void {}
function useProjectGoalEvents(_options: EntityEventHandlers = {}): void {}
function useProjectWhiteboardEvents(_options: EntityEventHandlers = {}): void {}
function useTimeEntryEvents(_options: EntityEventHandlers = {}): void {}
function useMilestoneEvents(_options: EntityEventHandlers = {}): void {}

interface UseEventTypeOptions {
  eventType: string;
  onEvent: (event: AnyPlatformEvent) => void;
  skipOwnEvents?: boolean;
}

function useEventType(_options: UseEventTypeOptions): void {}
