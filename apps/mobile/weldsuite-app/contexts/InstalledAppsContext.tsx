import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import api from '@/services/api';
import { useClerkAuth } from './ClerkAuthContext';

export interface InstalledApp {
  id: string;
  workspaceId: string;
  appCode: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
  status: string;
  displayOrder: number;
}

interface InstalledAppsContextValue {
  installedApps: InstalledApp[];
  isLoading: boolean;
  error: Error | null;
  refreshApps: () => Promise<void>;
  isAppInstalled: (appCode: string) => boolean;
  getAppByCode: (appCode: string) => InstalledApp | undefined;
}

const InstalledAppsContext = createContext<InstalledAppsContextValue | undefined>(undefined);

interface InstalledAppsProviderProps {
  children: React.ReactNode;
}

export function InstalledAppsProvider({ children }: InstalledAppsProviderProps) {
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { user } = useClerkAuth();

  const fetchInstalledApps = useCallback(async () => {
    if (!user) {
      setInstalledApps([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const apps = await api.getInstalledApps();
      // WeldAgent (AI assistant) has been removed along with the AI backend.
      // Filter it out defensively in case a workspace still has it installed.
      setInstalledApps((apps || []).filter((app) => app.appCode !== 'agent'));
    } catch (err) {
      console.error('Failed to fetch installed apps:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch installed apps'));
      // Keep any previously loaded apps on error
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  // Separate refresh function that doesn't show loading state
  const refreshApps = useCallback(async () => {
    if (!user) return;

    try {
      setError(null);
      const apps = await api.getInstalledApps();
      setInstalledApps((apps || []).filter((app) => app.appCode !== 'agent'));
    } catch (err) {
      console.error('Failed to refresh installed apps:', err);
      // Keep existing apps on refresh error
    }
  }, [user]);

  // Fetch installed apps when auth state changes
  useEffect(() => {
    if (user) {
      fetchInstalledApps();
    } else {
      setInstalledApps([]);
      setIsLoading(false);
    }
  }, [user, fetchInstalledApps]);

  const isAppInstalled = useCallback((appCode: string): boolean => {
    return installedApps.some(app => app.appCode === appCode);
  }, [installedApps]);

  const getAppByCode = useCallback((appCode: string): InstalledApp | undefined => {
    return installedApps.find(app => app.appCode === appCode);
  }, [installedApps]);

  const value = useMemo(() => ({
    installedApps,
    isLoading,
    error,
    refreshApps,
    isAppInstalled,
    getAppByCode,
  }), [installedApps, isLoading, error, refreshApps, isAppInstalled, getAppByCode]);

  return (
    <InstalledAppsContext.Provider value={value}>
      {children}
    </InstalledAppsContext.Provider>
  );
}

export function useInstalledApps(): InstalledAppsContextValue {
  const context = useContext(InstalledAppsContext);
  if (context === undefined) {
    throw new Error('useInstalledApps must be used within an InstalledAppsProvider');
  }
  return context;
}

export default InstalledAppsContext;
