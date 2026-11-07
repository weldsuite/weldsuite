"use client"

/**
 * The panel beside a workflow canvas (WeldConnect's editor, a WeldReach
 * campaign sequence): 399px with a left border on large screens, covering the
 * editor below them. `EditorPanelHeader` is its 52px title bar with a close
 * button, the height of the editor's own tool row; `EditorPanelBody` scrolls,
 * `EditorPanelFooter` holds the panel's buttons.
 *
 *   ┌ canvas ─────────────────┬ Edit step      × ┐
 *   │                         │ fields …         │
 *   │                         │                  │
 *   │                         │ [ Delete step ]  │
 *   └─────────────────────────┴──────────────────┘
 */

import * as React from "react"
import { X } from "lucide-react"
import { cn } from "../lib/utils"
import { useUiLabels } from "../providers/ui-labels-provider"
import { Button } from "./button"

export interface EditorSidePanelProps extends React.HTMLAttributes<HTMLElement> {
  /** Below `lg` the panel covers the editor; while `false` it slides away there. Always shown from `lg`. */
  open?: boolean
}

export function EditorSidePanel({ open = true, className, children, ...props }: Readonly<EditorSidePanelProps>) {
  return (
    <aside
      className={cn(
        "bg-background flex flex-col z-50",
        // Below lg: covers the editor area. Absolute (not viewport-fixed) so it
        // stays inside the page content, which already sits right of the app rail.
        "absolute inset-0 w-full transform transition-transform duration-200",
        "lg:relative lg:inset-auto lg:w-[399px] lg:shrink-0 lg:border-l",
        open ? "translate-y-0" : "translate-y-full lg:translate-y-0 lg:translate-x-0",
        className,
      )}
      {...props}
    >
      {children}
    </aside>
  )
}

export function EditorPanelCloseButton({ onClick, label }: Readonly<{ onClick: () => void; label?: string }>) {
  const labels = useUiLabels()
  const text = label ?? labels.close
  return (
    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClick} aria-label={text} title={text}>
      <X className="h-4 w-4" />
    </Button>
  )
}

/** Title bar of the panel: its title and, with `onClose`, the close button; 52px tall like the editor's tool row. */
export function EditorPanelHeader({
  title,
  onClose,
  closeLabel,
  className,
}: Readonly<{ title: React.ReactNode; onClose?: () => void; closeLabel?: string; className?: string }>) {
  return (
    <div className={cn("h-[52px] shrink-0 px-3 border-b flex items-center justify-between", className)}>
      <h3 className="font-semibold text-sm">{title}</h3>
      {onClose && <EditorPanelCloseButton onClick={onClose} label={closeLabel} />}
    </div>
  )
}

export function EditorPanelBody({ className, children }: Readonly<{ className?: string; children: React.ReactNode }>) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn("p-4 space-y-4", className)}>{children}</div>
    </div>
  )
}

/** A titled block in the body, under a divider: the "SETTINGS" heading of WeldConnect's step panel. */
export function EditorPanelSection({
  title,
  className,
  children,
}: Readonly<{ title: React.ReactNode; className?: string; children: React.ReactNode }>) {
  return (
    <div className={cn("border-t pt-4", className)}>
      <h4 className="text-xs font-medium mb-3 text-muted-foreground uppercase tracking-wide">{title}</h4>
      {children}
    </div>
  )
}

export function EditorPanelFooter({ className, children }: Readonly<{ className?: string; children: React.ReactNode }>) {
  return <div className={cn("p-3 space-y-2", className)}>{children}</div>
}
