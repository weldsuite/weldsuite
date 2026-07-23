'use client'

import { createContext, useContext } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface ApiVersion {
  version: string
  status: 'current' | 'supported' | 'deprecated'
  label: string
  description: string
  releaseDate: string
}

export const API_VERSIONS: ApiVersion[] = [
  {
    version: 'v1',
    status: 'current',
    label: 'v1',
    description: 'Current stable version, served under the /v1 path.',
    releaseDate: '2024-12-01',
  },
]

export const CURRENT_VERSION = 'v1'
export const MINIMUM_VERSION = 'v1'

interface VersionState {
  selectedVersion: string
  setSelectedVersion: (version: string) => void
}

export const useVersionStore = create<VersionState>()(
  persist(
    (set) => ({
      selectedVersion: CURRENT_VERSION,
      setSelectedVersion: (version) => set({ selectedVersion: version }),
    }),
    {
      name: 'weldsuite-api-version',
    }
  )
)

// Helper to compare versions (date-based, so string comparison works)
export function isVersionAtLeast(version: string, minVersion: string): boolean {
  return version >= minVersion
}

export function isVersionBefore(version: string, maxVersion: string): boolean {
  return version < maxVersion
}

export function getVersionInfo(version: string): ApiVersion | undefined {
  return API_VERSIONS.find((v) => v.version === version)
}

// Context for SSR safety
const VersionContext = createContext<string>(CURRENT_VERSION)

export function VersionProvider({ children }: { children: React.ReactNode }) {
  return (
    <VersionContext.Provider value={CURRENT_VERSION}>
      {children}
    </VersionContext.Provider>
  )
}

export function useVersion() {
  return useVersionStore((state) => state.selectedVersion)
}

export function useSetVersion() {
  return useVersionStore((state) => state.setSelectedVersion)
}
