// Local same-tab event bus for imperative UI refresh (e.g. WeldAgent tools,
// workflow editor sidebar). NOT the live multi-user sync path — that is
// exclusively `useRealtimeSync(platformSyncMap)` via RealtimeSyncBridge.
//
// The former `initializeRealtimeBridge` stub is gone (Phase 9). Do not
// reinstate a parallel realtime → dataEvents bridge.

type DataEventType =
  | 'projects:changed'
  | 'tasks:changed'
  | 'people:changed'
  | 'companies:changed'
  | 'leads:changed'
  | 'opportunities:changed'
  | 'products:changed'
  | 'inventory:changed'
  | 'invoices:changed'
  | 'bills:changed'
  | 'payments:changed'
  | 'tickets:changed'
  | 'notifications:changed'
  | 'meetings:changed'
  | 'calendar_events:changed'
  | 'workflows:changed';

type DataEventListener = () => void;

class DataEventEmitter {
  private listeners: Map<DataEventType, Set<DataEventListener>> = new Map();

  on(event: DataEventType, listener: DataEventListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);

    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  emit(event: DataEventType): void {
    this.listeners.get(event)?.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error(`[DataEvents] Error in listener for ${event}:`, error);
      }
    });
  }

  emitProjectsChanged(): void {
    this.emit('projects:changed');
  }

  emitTasksChanged(): void {
    this.emit('tasks:changed');
  }

  emitPeopleChanged(): void {
    this.emit('people:changed');
  }

  emitCompaniesChanged(): void {
    this.emit('companies:changed');
  }

  emitLeadsChanged(): void {
    this.emit('leads:changed');
  }

  emitOpportunitiesChanged(): void {
    this.emit('opportunities:changed');
  }

  emitProductsChanged(): void {
    this.emit('products:changed');
  }

  emitInventoryChanged(): void {
    this.emit('inventory:changed');
  }

  emitInvoicesChanged(): void {
    this.emit('invoices:changed');
  }

  emitBillsChanged(): void {
    this.emit('bills:changed');
  }

  emitPaymentsChanged(): void {
    this.emit('payments:changed');
  }

  emitTicketsChanged(): void {
    this.emit('tickets:changed');
  }

  emitNotificationsChanged(): void {
    this.emit('notifications:changed');
  }

  emitMeetingsChanged(): void {
    this.emit('meetings:changed');
  }

  emitCalendarEventsChanged(): void {
    this.emit('calendar_events:changed');
  }

  emitWorkflowsChanged(): void {
    this.emit('workflows:changed');
  }
}

export const dataEvents = new DataEventEmitter();

import { useEffect } from 'react';

export function useDataEvent(event: DataEventType, callback: DataEventListener): void {
  useEffect(() => {
    return dataEvents.on(event, callback);
  }, [event, callback]);
}

export type { DataEventType };
