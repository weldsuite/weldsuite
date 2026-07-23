import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  WarehouseDto,
  InventoryDto,
  WmsOrderDto,
  PickListDto,
  DashboardOverviewDto,
} from '../types/wms';
import api from '../services/api';

// ============================================================================
// TYPES
// ============================================================================

interface WmsState {
  // Cache
  dashboardData: DashboardOverviewDto | null;
  lastDashboardUpdate: number | null;

  // Loading states
  loading: {
    dashboard: boolean;
  };

  // Errors
  errors: {
    dashboard: string | null;
  };

  // Real-time updates
  realtimeEnabled: boolean;

  // Offline queue
  offlineQueue: OfflineAction[];
}

interface OfflineAction {
  id: string;
  type: string;
  payload: any;
  timestamp: number;
}

interface WmsContextValue extends WmsState {
  // Dashboard
  loadDashboard: (force?: boolean) => Promise<void>;
  refreshDashboard: () => Promise<void>;

  // Cache management
  clearCache: () => Promise<void>;
  invalidateCache: (key: string) => void;

  // Real-time
  enableRealtime: () => void;
  disableRealtime: () => void;

  // Offline queue
  addToOfflineQueue: (action: Omit<OfflineAction, 'id' | 'timestamp'>) => Promise<void>;
  processOfflineQueue: () => Promise<void>;
  clearOfflineQueue: () => Promise<void>;

  // Utility
  isDataStale: (lastUpdate: number | null, maxAge?: number) => boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STORAGE_KEYS = {
  DASHBOARD_DATA: '@wms_dashboard_data',
  DASHBOARD_TIMESTAMP: '@wms_dashboard_timestamp',
  OFFLINE_QUEUE: '@wms_offline_queue',
  REALTIME_ENABLED: '@wms_realtime_enabled',
};

const CACHE_DURATION = {
  DASHBOARD: 5 * 60 * 1000, // 5 minutes
  WAREHOUSES: 30 * 60 * 1000, // 30 minutes
  INVENTORY: 2 * 60 * 1000, // 2 minutes
};

// ============================================================================
// CONTEXT
// ============================================================================

const WmsContext = createContext<WmsContextValue | undefined>(undefined);

// ============================================================================
// PROVIDER
// ============================================================================

export function WmsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WmsState>({
    dashboardData: null,
    lastDashboardUpdate: null,
    loading: {
      dashboard: false,
    },
    errors: {
      dashboard: null,
    },
    realtimeEnabled: true,
    offlineQueue: [],
  });

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  useEffect(() => {
    initialize();
  }, []);

  const initialize = async () => {
    try {
      // Load from storage
      const [
        savedDashboard,
        savedTimestamp,
        savedQueue,
        savedRealtime,
      ] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.DASHBOARD_DATA),
        AsyncStorage.getItem(STORAGE_KEYS.DASHBOARD_TIMESTAMP),
        AsyncStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE),
        AsyncStorage.getItem(STORAGE_KEYS.REALTIME_ENABLED),
      ]);

      // Validate cached dashboard data structure
      let validDashboardData = null;
      if (savedDashboard) {
        try {
          const parsed = JSON.parse(savedDashboard);
          // Check if dashboard has the new structure with totalInventoryValue.amount
          if (parsed && typeof parsed.totalInventoryValue?.amount === 'number') {
            validDashboardData = parsed;
          } else {
            // Clear invalid cached data
            await Promise.all([
              AsyncStorage.removeItem(STORAGE_KEYS.DASHBOARD_DATA),
              AsyncStorage.removeItem(STORAGE_KEYS.DASHBOARD_TIMESTAMP),
            ]);
          }
        } catch (e) {
          console.warn('Failed to parse cached dashboard data', e);
        }
      }

      setState((prev) => ({
        ...prev,
        dashboardData: validDashboardData,
        lastDashboardUpdate: validDashboardData && savedTimestamp ? parseInt(savedTimestamp) : null,
        offlineQueue: savedQueue ? JSON.parse(savedQueue) : [],
        realtimeEnabled: savedRealtime ? JSON.parse(savedRealtime) : true,
      }));
    } catch (error) {
      console.error('Failed to initialize WMS context:', error);
    }
  };


  // ============================================================================
  // DASHBOARD
  // ============================================================================

  const loadDashboard = useCallback(async (force = false) => {
    // Check if cached data is still fresh
    if (
      !force &&
      state.dashboardData &&
      state.lastDashboardUpdate &&
      !isDataStale(state.lastDashboardUpdate, CACHE_DURATION.DASHBOARD)
    ) {
      return; // Use cached data
    }

    setState((prev) => ({
      ...prev,
      loading: { ...prev.loading, dashboard: true },
      errors: { ...prev.errors, dashboard: null },
    }));

    try {
      const response = await api.getWmsDashboard();

      if (response.success && response.data) {
        const now = Date.now();
        setState((prev) => ({
          ...prev,
          dashboardData: response.data || null,
          lastDashboardUpdate: now,
          loading: { ...prev.loading, dashboard: false },
        }));

        await Promise.all([
          AsyncStorage.setItem(
            STORAGE_KEYS.DASHBOARD_DATA,
            JSON.stringify(response.data)
          ),
          AsyncStorage.setItem(
            STORAGE_KEYS.DASHBOARD_TIMESTAMP,
            now.toString()
          ),
        ]);
      } else {
        throw new Error(response.error || 'Failed to load dashboard');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setState((prev) => ({
        ...prev,
        loading: { ...prev.loading, dashboard: false },
        errors: { ...prev.errors, dashboard: message },
      }));
      console.error('Failed to load dashboard:', error);
    }
  }, [state.dashboardData, state.lastDashboardUpdate]);

  const refreshDashboard = useCallback(async () => {
    await loadDashboard(true);
  }, [loadDashboard]);

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  const clearCache = useCallback(async () => {
    try {
      await Promise.all([
        AsyncStorage.removeItem(STORAGE_KEYS.DASHBOARD_DATA),
        AsyncStorage.removeItem(STORAGE_KEYS.DASHBOARD_TIMESTAMP),
      ]);

      setState((prev) => ({
        ...prev,
        dashboardData: null,
        lastDashboardUpdate: null,
      }));
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  }, []);

  const invalidateCache = useCallback((key: string) => {
    switch (key) {
      case 'dashboard':
        setState((prev) => ({
          ...prev,
          lastDashboardUpdate: null,
        }));
        break;
      // Add more cache keys as needed
    }
  }, []);

  // ============================================================================
  // REAL-TIME
  // ============================================================================

  const enableRealtime = useCallback(() => {
    setState((prev) => ({ ...prev, realtimeEnabled: true }));
    AsyncStorage.setItem(STORAGE_KEYS.REALTIME_ENABLED, 'true');
  }, []);

  const disableRealtime = useCallback(() => {
    setState((prev) => ({ ...prev, realtimeEnabled: false }));
    AsyncStorage.setItem(STORAGE_KEYS.REALTIME_ENABLED, 'false');
  }, []);

  // ============================================================================
  // OFFLINE QUEUE
  // ============================================================================

  const addToOfflineQueue = useCallback(
    async (action: Omit<OfflineAction, 'id' | 'timestamp'>) => {
      const newAction: OfflineAction = {
        ...action,
        id: Date.now().toString(),
        timestamp: Date.now(),
      };

      const updatedQueue = [...state.offlineQueue, newAction];
      setState((prev) => ({ ...prev, offlineQueue: updatedQueue }));

      await AsyncStorage.setItem(
        STORAGE_KEYS.OFFLINE_QUEUE,
        JSON.stringify(updatedQueue)
      );
    },
    [state.offlineQueue]
  );

  const processOfflineQueue = useCallback(async () => {
    if (state.offlineQueue.length === 0) return;

    // Process actions sequentially
    const results = [];
    for (const action of state.offlineQueue) {
      try {
        // Process based on action type
        // This will be expanded based on actual offline actions
        results.push({ id: action.id, success: true });
      } catch (error) {
        console.error('Failed to process action:', action.id, error);
        results.push({ id: action.id, success: false, error });
      }
    }

    // Remove successfully processed actions
    const successfulIds = results.filter((r) => r.success).map((r) => r.id);
    const remainingQueue = state.offlineQueue.filter(
      (a) => !successfulIds.includes(a.id)
    );

    setState((prev) => ({ ...prev, offlineQueue: remainingQueue }));
    await AsyncStorage.setItem(
      STORAGE_KEYS.OFFLINE_QUEUE,
      JSON.stringify(remainingQueue)
    );
  }, [state.offlineQueue]);

  const clearOfflineQueue = useCallback(async () => {
    setState((prev) => ({ ...prev, offlineQueue: [] }));
    await AsyncStorage.removeItem(STORAGE_KEYS.OFFLINE_QUEUE);
  }, []);

  // ============================================================================
  // UTILITY
  // ============================================================================

  const isDataStale = useCallback(
    (lastUpdate: number | null, maxAge = CACHE_DURATION.DASHBOARD): boolean => {
      if (!lastUpdate) return true;
      return Date.now() - lastUpdate > maxAge;
    },
    []
  );

  // ============================================================================
  // CONTEXT VALUE
  // ============================================================================

  const value: WmsContextValue = {
    ...state,
    loadDashboard,
    refreshDashboard,
    clearCache,
    invalidateCache,
    enableRealtime,
    disableRealtime,
    addToOfflineQueue,
    processOfflineQueue,
    clearOfflineQueue,
    isDataStale,
  };

  return <WmsContext.Provider value={value}>{children}</WmsContext.Provider>;
}

// ============================================================================
// HOOK
// ============================================================================

export function useWms() {
  const context = useContext(WmsContext);
  if (context === undefined) {
    throw new Error('useWms must be used within a WmsProvider');
  }
  return context;
}

// Export types
export type { WmsContextValue, WmsState, OfflineAction };
