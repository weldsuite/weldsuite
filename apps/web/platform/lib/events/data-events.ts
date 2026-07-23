// Global event system for data mutations
// Used to notify components when data changes (e.g., from WeldAgent tools or @weldsuite/realtime events)

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
  private realtimeBridgeInitialized = false;

  on(event: DataEventType, listener: DataEventListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);

    // Return unsubscribe function
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

  // Convenience methods for common events
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

  /**
   * Bridge from platform realtime → local data events. Stubbed after
   * @weldsuite/realtime integration; wire up to @weldsuite/realtime when
   * reinstating cross-tab cache invalidation.
   */
  initializeRealtimeBridge(_currentUserId?: string): void {
    if (this.realtimeBridgeInitialized) return;
    this.realtimeBridgeInitialized = true;
  }
}

// Singleton instance
export const dataEvents = new DataEventEmitter();

// React hook for subscribing to data events
import { useEffect } from 'react';

export function useDataEvent(event: DataEventType, callback: DataEventListener): void {
  useEffect(() => {
    return dataEvents.on(event, callback);
  }, [event, callback]);
}

// Export the DataEventType for use elsewhere
export type { DataEventType };
