"use client"

import * as React from "react"
import { Loader2, X } from "lucide-react"

import { cn } from "../lib/utils"

/**
 * The chat composer's parts, shared by every composer that should look alike
 * (the WeldAgent panel and pages, WeldChat): a rounded box with the field on
 * top and a row of actions under it, ending in the send button. Each app
 * keeps its own field and actions; only the look lives here.
 */

/** The box. Clicking its empty parts should focus the field (`onClick`). */
function ComposerFrame({
  className,
  disabled,
  ...props
}: React.ComponentProps<"div"> & { disabled?: boolean }) {
  return (
    <div
      role="presentation"
      data-slot="composer"
      className={cn(
        "relative flex w-full cursor-text flex-col rounded-[20px] border border-gray-200 bg-white p-[10px] shadow-[0_1px_4px_-1px_rgba(0,0,0,0.03)] dark:border-border dark:bg-background",
        disabled && "opacity-60",
        className
      )}
      {...props}
    />
  )
}

/**
 * A strip above the field about the next message: what it replies to, that
 * it edits an earlier one, a suggestion. 36px tall for one line, inset like
 * the field, its corners following the box's. `onDismiss` adds a close
 * button named `dismissLabel`.
 */
function ComposerNotice({
  icon,
  actions,
  onDismiss,
  dismissLabel,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  icon?: React.ReactNode
  /** Buttons before the close button. */
  actions?: React.ReactNode
  onDismiss?: () => void
  dismissLabel?: string
}) {
  return (
    <div
      data-slot="composer-notice"
      className={cn(
        "mb-1 flex min-h-9 items-center gap-2 rounded-[10px] bg-gray-100 py-1.5 pr-1.5 pl-3 text-[13px] leading-5 text-foreground dark:bg-secondary/60 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
      {actions}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          title={dismissLabel}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-gray-200 hover:text-foreground dark:hover:bg-accent"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/** The row under the field: actions at the start, send at the end. */
function ComposerActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-actions"
      className={cn("mt-auto flex items-center justify-between", className)}
      {...props}
    />
  )
}

/**
 * The field's look, for a `<textarea>` or a `contentEditable` element (which
 * shows its `data-placeholder` while empty). It grows to 200px, then scrolls.
 */
const composerFieldClass =
  "max-h-[200px] min-h-[40px] w-full flex-1 resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent pb-3 pl-[10px] pt-[7px] text-[15px] text-gray-900 outline-none [scrollbar-color:rgba(200,200,200,0.3)_transparent] [scrollbar-width:thin] placeholder:text-gray-500 dark:text-foreground dark:placeholder:text-muted-foreground empty:before:pointer-events-none empty:before:text-gray-500 empty:before:content-[attr(data-placeholder)] dark:empty:before:text-muted-foreground"

/** The look of an icon button in the actions row (attach, emoji, mention, …). */
const composerIconButtonClass =
  "size-8 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground"

/**
 * Send: a rounded square, solid while there is something to send and plain
 * grey (never faded) while there isn't. A submit button unless `type` says
 * otherwise; `label` is its accessible name and tooltip.
 */
function ComposerSendButton({
  canSend,
  isSending = false,
  label,
  className,
  disabled,
  ...props
}: Omit<React.ComponentProps<"button">, "children"> & {
  canSend: boolean
  isSending?: boolean
  label: string
}) {
  return (
    <button
      type="submit"
      aria-label={label}
      title={label}
      {...props}
      disabled={disabled || !canSend}
      data-slot="composer-send"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-[12px] transition-all",
        canSend
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "cursor-not-allowed bg-gray-300 text-gray-500 dark:bg-muted dark:text-muted-foreground",
        className
      )}
    >
      {isSending ? (
        <Loader2 className="size-[15px] animate-spin" aria-hidden="true" />
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth="2.5"
          stroke="currentColor"
          className="size-[15px]"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
        </svg>
      )}
    </button>
  )
}

export {
  ComposerFrame,
  ComposerNotice,
  ComposerActions,
  ComposerSendButton,
  composerFieldClass,
  composerIconButtonClass,
}
