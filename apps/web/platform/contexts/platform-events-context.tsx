/**
 * Platform Events Context — stub after @weldsuite/realtime migration.
 *
 * Public API preserved for consumers; subscription methods return no-op
 * unsubscribers. Consumers should migrate to @weldsuite/realtime's useTopic /
 * useRealtimeEvent.
 */

import React, { createContext, useContext } from 'react';
import type {
  AnyPlatformEvent,
  PlatformConnectionState,
} from '@/lib/platform-events/types';

interface PlatformEventsContextValue {
  isConnected: boolean;
  connectionState: PlatformConnectionState;
  subscribe: (handler: (event: AnyPlatformEvent) => void) => () => void;
  subscribeToEntity: (
    entityType: string,
    handler: (event: AnyPlatformEvent) => void,
  ) => () => void;
  subscribeToEventType: (
    eventType: string,
    handler: (event: AnyPlatformEvent) => void,
  ) => () => void;
}

const noopUnsub = () => {};

const defaultValue: PlatformEventsContextValue = {
  isConnected: false,
  connectionState: 'disconnected',
  subscribe: () => noopUnsub,
  subscribeToEntity: () => noopUnsub,
  subscribeToEventType: () => noopUnsub,
};

const PlatformEventsContext = createContext<PlatformEventsContextValue>(defaultValue);

interface PlatformEventsProviderProps {
  children: React.ReactNode;
}

export function PlatformEventsProvider({ children }: PlatformEventsProviderProps) {
  return (
    <PlatformEventsContext.Provider value={defaultValue}>
      {children}
    </PlatformEventsContext.Provider>
  );
}

export function usePlatformEvents(): PlatformEventsContextValue {
  return useContext(PlatformEventsContext);
}
