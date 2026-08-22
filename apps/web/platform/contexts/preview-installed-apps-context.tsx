'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { InstalledApp } from '@/lib/api/apps';

const PreviewInstalledAppsContext = createContext<InstalledApp[] | null>(null);

export function PreviewInstalledAppsProvider({
  apps,
  children,
}: {
  apps: InstalledApp[];
  children: ReactNode;
}) {
  return (
    <PreviewInstalledAppsContext.Provider value={apps}>
      {children}
    </PreviewInstalledAppsContext.Provider>
  );
}

export function usePreviewInstalledAppsOverride() {
  return useContext(PreviewInstalledAppsContext);
}
