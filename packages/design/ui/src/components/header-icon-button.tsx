"use client"

import * as React from "react"

import { cn } from "../lib/utils"
import { Button } from "./button"

/**
 * An icon button in a record's header row: WeldMail's message actions (star,
 * archive, snooze, delete) and WeldDesk's conversation actions (assign, create
 * ticket, more). One component so those rows always look the same: 28px
 * square on desktop (36px to tap on phones), a grey icon, a light hover, and
 * the hover look kept while its menu is open.
 *
 * The icon is the child; `label` is its accessible name and tooltip. Works as
 * a `DropdownMenuTrigger` / `PopoverTrigger` child (`asChild`).
 */
export interface HeaderIconButtonProps extends Omit<React.ComponentProps<typeof Button>, "variant" | "size"> {
  label: string
  /** Red on hover, for a destructive action such as delete. */
  destructive?: boolean
}

const HeaderIconButton = React.forwardRef<HTMLButtonElement, HeaderIconButtonProps>(
  ({ label, destructive = false, className, children, ...props }, ref) => (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      data-header-icon-button=""
      className={cn(
        "rounded-md p-1.5 text-gray-500 transition-colors md:size-7 dark:text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        destructive
          ? "hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
          : "hover:bg-gray-100 data-[state=open]:bg-gray-100 dark:hover:bg-secondary dark:data-[state=open]:bg-secondary",
        className
      )}
      {...props}
    >
      {children}
    </Button>
  )
)
HeaderIconButton.displayName = "HeaderIconButton"

export { HeaderIconButton }
