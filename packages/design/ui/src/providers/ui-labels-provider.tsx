"use client"

import * as React from "react"

/**
 * Text the shared components render themselves (close buttons, presence
 * status, loaders, confirm/cancel, dismiss, retry). The ui package has no
 * i18n of its own, so an app passes its translations once at the root;
 * without a provider the English defaults apply. A component that also takes
 * the same text as a prop (`ConfirmDialog`'s `confirmLabel`, `PageLoader`'s
 * `label`) prefers the prop.
 */
export interface UiLabels {
  close: string
  search: string
  send: string
  back: string
  dismiss: string
  retry: string
  /** Loader text (`PageLoader`). */
  loading: string
  /** Default message of a failed load (`ErrorState`). */
  loadError: string
  confirm: string
  cancel: string
  save: string
  presence: {
    online: string
    busy: string
    dnd: string
    away: string
    offline: string
  }
  auditTimeline: {
    noActivity: string
    details: string
    /** A change from or to nothing. */
    none: string
    /** The `todo` status value. */
    todo: string
  }
}

export const DEFAULT_UI_LABELS: UiLabels = {
  close: "Close",
  search: "Search",
  send: "Send",
  back: "Back",
  dismiss: "Dismiss",
  retry: "Try again",
  loading: "Loading...",
  loadError: "Something went wrong while loading.",
  confirm: "Confirm",
  cancel: "Cancel",
  save: "Save",
  presence: {
    online: "Available",
    busy: "Busy",
    dnd: "Do Not Disturb",
    away: "Away",
    offline: "Offline",
  },
  auditTimeline: {
    noActivity: "No activity yet",
    details: "Details",
    none: "none",
    todo: "To Do",
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
