"use client"

import * as React from "react"
import { EllipsisVertical } from "lucide-react"

import { cn } from "../lib/utils"
import { Badge } from "./badge"
import { Button } from "./button"
import { Checkbox } from "./checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu"
import { Skeleton } from "./skeleton"

/**
 * Presentational list of automation workflows / sequences.
 *
 * Self-contained and prop-driven — it has no knowledge of routing, data
 * fetching, or i18n. The host app maps its domain objects to
 * {@link WorkflowListItem}s, passes pre-formatted strings (e.g. "3d ago"),
 * and wires the row click + action callbacks. Shared by WeldConnect
 * (workflows) and WeldCRM (sequences).
 */

export type WorkflowStatus = "active" | "paused" | "draft" | "archived" | (string & {})

export type WorkflowTriggerVariant =
  | "manual"
  | "schedule"
  | "webhook"
  | "event"
  | "default"

export interface WorkflowListItem {
  id: string
  name: string
  description?: string | null
  status: WorkflowStatus
  /** Optional label rendered as a trigger badge (e.g. "Schedule", "Manual"). */
  triggerLabel?: string | null
  /** Controls the trigger badge color. Defaults to "default". */
  triggerVariant?: WorkflowTriggerVariant
  /** Pre-formatted last-activity string, e.g. "3d ago". */
  lastActivityLabel?: string | null
  /**
   * Optional extra cell rendered between the trigger and status columns —
   * used for domain metrics like the "enrolled" count on CRM sequences.
   */
  meta?: React.ReactNode
}

export interface WorkflowListGroup {
  id: string
  label: string
  /** Predicate deciding which items fall into this group. */
  match: (item: WorkflowListItem) => boolean
  /** Lower numbers render first. */
  sortOrder?: number
}

export interface WorkflowListAction {
  id: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onSelect: (item: WorkflowListItem) => void
  /** Render a separator above this item. */
  separatorBefore?: boolean
  /** Style the item as destructive (red). */
  destructive?: boolean
  /** Hide this action for specific items. */
  hidden?: (item: WorkflowListItem) => boolean
}

export interface WorkflowStatusStyle {
  label: string
  className: string
}

export interface WorkflowListLabels {
  /** Header above the name column. Defaults to "Workflow". */
  name: string
  trigger: string
  status: string
  /** Header above the last-activity column. Defaults to "Last Modified". */
  lastActivity: string
  /** Header above the optional meta column. */
  meta: string
}

export interface WorkflowListProps {
  items: WorkflowListItem[]
  /**
   * Optional grouping. When omitted the list renders flat without section
   * headers. Items matching no group are dropped from a grouped view.
   */
  groups?: WorkflowListGroup[]
  /** Per-row action menu. Omit (or pass empty) to hide the trailing menu. */
  actions?: WorkflowListAction[]
  onSelectItem?: (item: WorkflowListItem) => void
  /** Show the trigger column + badge. Defaults to true. */
  showTrigger?: boolean
  /** Show the meta column. Defaults to true when any item has `meta`. */
  showMeta?: boolean
  isLoading?: boolean
  labels?: Partial<WorkflowListLabels>
  /** Override or extend the status badge styling, keyed by status value. */
  statusConfig?: Record<string, WorkflowStatusStyle>
  emptyState?: React.ReactNode
  className?: string
}

const DEFAULT_LABELS: WorkflowListLabels = {
  name: "Workflow",
  trigger: "Trigger",
  status: "Status",
  lastActivity: "Last Modified",
  meta: "",
}

const DEFAULT_STATUS_CONFIG: Record<string, WorkflowStatusStyle> = {
  active: {
    label: "Active",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  paused: {
    label: "Paused",
    className:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  },
  draft: {
    label: "Draft",
    className:
      "bg-gray-100 text-gray-800 dark:bg-background/40 dark:text-muted-foreground",
  },
  archived: {
    label: "Archived",
    className:
      "bg-gray-100 text-gray-500 dark:bg-background/40 dark:text-muted-foreground",
  },
}

const TRIGGER_VARIANT_CLASS: Record<WorkflowTriggerVariant, string> = {
  manual: "bg-gray-100 text-gray-800 dark:bg-background/40 dark:text-muted-foreground",
  schedule: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  webhook: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  event: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
  default: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
}

function statusStyle(
  status: WorkflowStatus,
  config: Record<string, WorkflowStatusStyle>
): WorkflowStatusStyle {
  return (
    config[status] ?? {
      label: status,
      className:
        "bg-gray-100 text-gray-800 dark:bg-background/40 dark:text-muted-foreground",
    }
  )
}

/** The connected-cards illustration used as the default empty-state visual. */
export function WorkflowListEmptyIllustration({
  className,
}: {
  className?: string
}) {
  return (
    <svg
      width="140"
      height="120"
      viewBox="0 0 140 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M46 32L46 38C46 44 52 44 58 44L62 44" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
      <path d="M108 50L112 50C118 50 118 56 118 62L118 66C118 72 112 72 106 72L80 72" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
      <path d="M42 78L38 78C32 78 32 84 32 90L32 92C32 98 38 98 44 98L58 98" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
      <circle cx="62" cy="44" r="2" className="fill-gray-200 dark:fill-border" />
      <circle cx="80" cy="72" r="2" className="fill-gray-200 dark:fill-border" />
      <circle cx="58" cy="98" r="2" className="fill-gray-200 dark:fill-border" />
      <rect x="22" y="14" width="48" height="18" rx="5" className="fill-white dark:fill-secondary" />
      <rect x="22" y="14" width="48" height="18" rx="5" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
      <rect x="30" y="21" width="20" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.5" />
      <rect x="53" y="21" width="10" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.3" />
      <rect x="62" y="36" width="48" height="18" rx="5" className="fill-white dark:fill-secondary" />
      <rect x="62" y="36" width="48" height="18" rx="5" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
      <rect x="70" y="43" width="24" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.5" />
      <rect x="97" y="43" width="6" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.3" />
      <rect x="42" y="64" width="38" height="18" rx="5" className="fill-white dark:fill-secondary" />
      <rect x="42" y="64" width="38" height="18" rx="5" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
      <rect x="50" y="71" width="18" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.5" />
      <rect x="58" y="90" width="48" height="18" rx="5" className="fill-white dark:fill-secondary" />
      <rect x="58" y="90" width="48" height="18" rx="5" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
      <rect x="66" y="97" width="28" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.5" />
      <rect x="97" y="97" width="4" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.3" />
    </svg>
  )
}

function WorkflowListHeader({
  labels,
  showTrigger,
  showMeta,
  showActions,
}: {
  labels: WorkflowListLabels
  showTrigger: boolean
  showMeta: boolean
  showActions: boolean
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-200/70 dark:border-border text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <div className="flex-1 min-w-[250px]">{labels.name}</div>
      {showTrigger && <div className="w-[120px]">{labels.trigger}</div>}
      {showMeta && <div className="w-[120px]">{labels.meta}</div>}
      <div className="w-[110px]">{labels.status}</div>
      <div className="w-[120px]">{labels.lastActivity}</div>
      {showActions && <div className="w-[40px]" />}
    </div>
  )
}

export interface WorkflowListRowProps {
  item: WorkflowListItem
  /** Per-row action menu. Omit (or pass empty) to hide the trailing menu. */
  actions?: WorkflowListAction[]
  onSelectItem?: (item: WorkflowListItem) => void
  /** Show the trigger badge cell. Defaults to true. */
  showTrigger?: boolean
  /** Show the domain-meta cell. Defaults to false. */
  showMeta?: boolean
  /** Override or extend the status badge styling, keyed by status value. */
  statusConfig?: Record<string, WorkflowStatusStyle>
  /**
   * Render a leading checkbox cell for multi-select. Defaults to false, so
   * existing consumers (e.g. CRM sequences) are unaffected.
   */
  selectable?: boolean
  /** Whether this row's checkbox is checked. Only used when `selectable`. */
  selected?: boolean
  /** Fired when the row checkbox is toggled. Only used when `selectable`. */
  onSelectChange?: (checked: boolean) => void
  /** Accessible label for the row checkbox. */
  selectLabel?: string
}

/**
 * A single workflow row. Exported standalone so hosts that already own a list
 * shell (e.g. WeldConnect's `EntityList`) can render rows through the shared
 * component without adopting the full {@link WorkflowList} wrapper.
 */
export function WorkflowListRow({
  item,
  actions = [],
  onSelectItem,
  showTrigger = true,
  showMeta = false,
  statusConfig: statusOverrides,
  selectable = false,
  selected = false,
  onSelectChange,
  selectLabel,
}: WorkflowListRowProps) {
  const statusConfig = { ...DEFAULT_STATUS_CONFIG, ...statusOverrides }
  const status = statusStyle(item.status, statusConfig)
  const triggerVariant = item.triggerVariant ?? "default"
  const visibleActions = actions.filter((a) => !a.hidden?.(item))
  const interactive = Boolean(onSelectItem)

  return (
    <div
      onClick={interactive ? () => onSelectItem!(item) : undefined}
      className={cn(
        "group flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border",
        interactive &&
          "cursor-pointer hover:bg-gray-50 dark:hover:bg-secondary/50",
        selected && "bg-primary/5 dark:bg-primary/10"
      )}
    >
      {/* Selection checkbox */}
      {selectable && (
        <div
          className="flex w-4 items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelectChange?.(checked === true)}
            aria-label={selectLabel ?? `Select ${item.name}`}
          />
        </div>
      )}

      {/* Name + description */}
      <div className="flex-1 min-w-0">
        <span className="block truncate text-sm font-medium text-gray-900 dark:text-foreground">
          {item.name}
        </span>
        {item.description && (
          <p className="truncate text-xs text-muted-foreground">
            {item.description}
          </p>
        )}
      </div>

      {/* Trigger */}
      {showTrigger && (
        <div className="w-[120px] flex items-center">
          {item.triggerLabel && (
            <Badge
              className={cn(
                "rounded-md border-transparent text-xs font-medium",
                TRIGGER_VARIANT_CLASS[triggerVariant]
              )}
            >
              {item.triggerLabel}
            </Badge>
          )}
        </div>
      )}

      {/* Domain meta (e.g. enrolled count) */}
      {showMeta && (
        <div className="w-[120px] flex items-center text-sm text-muted-foreground">
          {item.meta}
        </div>
      )}

      {/* Status */}
      <div className="w-[110px] flex items-center">
        <Badge
          className={cn(
            "rounded-md border-transparent text-xs font-medium",
            status.className
          )}
        >
          {status.label}
        </Badge>
      </div>

      {/* Last activity */}
      <div className="w-[120px]">
        <span className="text-sm text-muted-foreground">
          {item.lastActivityLabel ?? "—"}
        </span>
      </div>

      {/* Actions */}
      {visibleActions.length > 0 && (
        <div
          className="w-[40px] flex justify-end"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open actions menu"
                className="opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
              >
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {visibleActions.map((action) => {
                const Icon = action.icon
                return (
                  <React.Fragment key={action.id}>
                    {action.separatorBefore && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={() => action.onSelect(item)}
                      className={cn(
                        action.destructive &&
                          "text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                      )}
                    >
                      {Icon && (
                        <Icon
                          className={cn(
                            "mr-2 h-4 w-4",
                            action.destructive && "text-red-600 dark:text-red-400"
                          )}
                        />
                      )}
                      {action.label}
                    </DropdownMenuItem>
                  </React.Fragment>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
}

export function WorkflowList({
  items,
  groups,
  actions = [],
  onSelectItem,
  showTrigger = true,
  showMeta,
  isLoading = false,
  labels: labelOverrides,
  statusConfig: statusOverrides,
  emptyState,
  className,
}: WorkflowListProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides }
  const statusConfig = { ...DEFAULT_STATUS_CONFIG, ...statusOverrides }
  const resolvedShowMeta = showMeta ?? items.some((item) => item.meta != null)
  const showActions = actions.length > 0

  const rowProps = {
    actions,
    onSelectItem,
    showTrigger,
    showMeta: resolvedShowMeta,
    statusConfig,
  }

  if (isLoading) {
    return (
      <div className={cn("w-full", className)}>
        <WorkflowListHeader
          labels={labels}
          showTrigger={showTrigger}
          showMeta={resolvedShowMeta}
          showActions={showActions}
        />
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border"
          >
            <div className="flex-1 min-w-[250px] space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            {showTrigger && <Skeleton className="h-5 w-16 rounded-md" />}
            {resolvedShowMeta && <Skeleton className="h-4 w-[120px]" />}
            <Skeleton className="h-5 w-16 rounded-md" />
            <Skeleton className="h-4 w-[120px]" />
            {showActions && <Skeleton className="h-8 w-8 rounded-md" />}
          </div>
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className={cn("w-full", className)}>
        {emptyState ?? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <WorkflowListEmptyIllustration />
            <p className="text-sm font-medium text-foreground">
              No {labels.name.toLowerCase()}s yet
            </p>
          </div>
        )}
      </div>
    )
  }

  // Flat list — no grouping.
  if (!groups || groups.length === 0) {
    return (
      <div className={cn("w-full", className)}>
        <WorkflowListHeader
          labels={labels}
          showTrigger={showTrigger}
          showMeta={resolvedShowMeta}
          showActions={showActions}
        />
        {items.map((item) => (
          <WorkflowListRow key={item.id} item={item} {...rowProps} />
        ))}
      </div>
    )
  }

  // Grouped list — render a section per non-empty group, ordered by sortOrder.
  const sortedGroups = [...groups].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  )

  return (
    <div className={cn("w-full", className)}>
      <WorkflowListHeader
        labels={labels}
        showTrigger={showTrigger}
        showMeta={resolvedShowMeta}
        showActions={showActions}
      />
      {sortedGroups.map((group) => {
        const groupItems = items.filter((item) => group.match(item))
        if (groupItems.length === 0) return null
        return (
          <div key={group.id}>
            <div className="flex items-center gap-2 px-4 py-2 bg-gray-50/60 dark:bg-secondary/30 border-b border-gray-200/70 dark:border-border">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </span>
              <span className="text-xs font-mono text-muted-foreground/70">
                {groupItems.length}
              </span>
            </div>
            {groupItems.map((item) => (
              <WorkflowListRow key={item.id} item={item} {...rowProps} />
            ))}
          </div>
        )
      })}
    </div>
  )
}
