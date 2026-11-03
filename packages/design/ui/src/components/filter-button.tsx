import * as React from "react"
import { Plus, X } from "lucide-react"

import { cn } from "../lib/utils"
import { Button } from "./button"

/**
 * Filter controls shared by every list and table toolbar: the "Filter"
 * button, the dashed "+" that adds another filter, and the pieces of an
 * active filter pill (`Field | operator | value | ×`) and its menus.
 *
 * Build filter UIs from these instead of styling buttons by hand, so every
 * filter in the app looks and behaves the same.
 */

/**
 * The "Filter" toolbar button. With `count` above 0 it turns active (primary
 * tint) and shows how many filters apply, even when that is 1.
 */
function FilterButton({
  count = 0,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { count?: number }) {
  const active = count > 0

  return (
    <Button
      data-slot="filter-button"
      variant="outline"
      className={cn(
        "h-8 px-3 text-sm text-muted-foreground shadow-none",
        active &&
          "gap-1.5 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary dark:border-primary/40 dark:bg-primary/10 dark:hover:bg-primary/15",
        className
      )}
      {...props}
    >
      {children}
      {active && <span className="tabular-nums">{count}</span>}
    </Button>
  )
}

/** The dashed "+" shown after the active filter pills to add another one. */
function FilterAddButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="filter-add-button"
      className={cn(
        "flex h-8 w-[30px] shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
        className
      )}
      {...props}
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  )
}

/** An active filter: the bordered row holding its label, segments and remove button. */
function FilterPill({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="filter-pill"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md border border-border bg-muted/50 text-sm",
        className
      )}
      {...props}
    />
  )
}

/** The field name at the start of a filter pill. */
function FilterPillLabel({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex h-full items-center px-2", className)} {...props}>
      <span className="whitespace-nowrap capitalize text-muted-foreground">{children}</span>
    </div>
  )
}

function FilterPillDivider({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("h-full w-px bg-border", className)} {...props} />
}

/**
 * A clickable segment of a filter pill (operator or value). `empty` shows it
 * as a placeholder until something is picked.
 */
function FilterPillButton({
  empty = false,
  className,
  ...props
}: React.ComponentProps<"button"> & { empty?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-full items-center whitespace-nowrap px-2 transition-colors hover:bg-accent",
        empty ? "text-muted-foreground/60" : "text-foreground",
        className
      )}
      {...props}
    />
  )
}

/** The × that removes a filter pill. */
function FilterPillRemove({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "h-full rounded-r-md px-[7px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className
      )}
      {...props}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  )
}

/** A row in a filter menu (field, operator or value list). */
function FilterMenuItem({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
        className
      )}
      {...props}
    />
  )
}

export {
  FilterButton,
  FilterAddButton,
  FilterPill,
  FilterPillLabel,
  FilterPillDivider,
  FilterPillButton,
  FilterPillRemove,
  FilterMenuItem,
}
