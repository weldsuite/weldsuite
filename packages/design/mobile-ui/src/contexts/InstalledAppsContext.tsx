import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useClerkAuth } from './ClerkAuthContext';
import type { InstalledApp } from '../types';

interface InstalledAppsApi {
  getInstalledApps: () => Promise<InstalledApp[]>;
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
  api: InstalledAppsApi;
}

export function InstalledAppsProvider({ children, api }: InstalledAppsProviderProps) {
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
      setInstalledApps(apps || []);
    } catch (err) {
      console.error('Failed to fetch installed apps:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch installed apps'));
    } finally {
      setIsLoading(false);
    }
  }, [user, api]);

  const refreshApps = useCallback(async () => {
    if (!user) return;

    try {
      setError(null);
      const apps = await api.getInstalledApps();
      setInstalledApps(apps || []);
    } catch (err) {
      console.error('Failed to refresh installed apps:', err);
    }
  }, [user, api]);

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
