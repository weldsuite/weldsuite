"use client"

import * as React from "react"

/**
 * Screen-reader text the shared components render themselves (close buttons,
 * presence status). The ui package has no i18n of its own, so an app passes
 * its translations once at the root; without a provider the English defaults
 * apply.
 */
export interface UiLabels {
  close: string
  search: string
  send: string
  presence: {
    online: string
    busy: string
    dnd: string
    away: string
    offline: string
  }
}

export const DEFAULT_UI_LABELS: UiLabels = {
  close: "Close",
  search: "Search",
  send: "Send",
  presence: {
    online: "Available",
    busy: "Busy",
    dnd: "Do Not Disturb",
    away: "Away",
    offline: "Offline",
  },
}

const UiLabelsContext = React.createContext<UiLabels>(DEFAULT_UI_LABELS)

export function UiLabelsProvider({
  labels,
  children,
}: Readonly<{ labels: UiLabels; children: React.ReactNode }>) {
  return <UiLabelsContext.Provider value={labels}>{children}</UiLabelsContext.Provider>
}

export function useUiLabels(): UiLabels {
  return React.useContext(UiLabelsContext)
}
