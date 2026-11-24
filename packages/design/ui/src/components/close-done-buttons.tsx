"use client"

import * as React from "react"
import { ArrowLeft, Check, X } from "lucide-react"

import { cn } from "../lib/utils"
import { Button } from "./button"

/**
 * The pair at the start of a record's header row: close it (or go back) and
 * mark it done, in one small bordered box with a line between them. WeldMail's
 * message header and WeldDesk's conversation and ticket headers use it, so
 * they always look the same.
 */
export interface CloseDoneButtonsProps {
  /** Leave the record: back to the list. */
  onClose: () => void
  /** Accessible name and tooltip of the close button. */
  closeLabel: string
  /** Show a back arrow instead of the cross (the record was opened from somewhere to return to). */
  back?: boolean
  /** Mark the record done (archive, close, resolve). */
  onDone: () => void
  /** Accessible name and tooltip of the done button. */
  doneLabel: string
  doneDisabled?: boolean
  className?: string
}

const buttonClass = "h-full w-7 p-1 transition-colors hover:bg-gray-100 dark:hover:bg-secondary"
const iconClass = "h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground"

function CloseDoneButtons({
  onClose,
  closeLabel,
  back = false,
  onDone,
  doneLabel,
  doneDisabled,
  className,
}: Readonly<CloseDoneButtonsProps>) {
  const CloseIcon = back ? ArrowLeft : X
  return (
    <div
      data-slot="close-done-buttons"
      className={cn("flex h-7 flex-shrink-0 items-center overflow-hidden rounded-md border border-border", className)}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={buttonClass}
        onClick={onClose}
        aria-label={closeLabel}
        title={closeLabel}
      >
        <CloseIcon className={iconClass} />
      </Button>
      <div className="h-4 w-px bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={buttonClass}
        onClick={onDone}
        disabled={doneDisabled}
        aria-label={doneLabel}
        title={doneLabel}
      >
        <Check className={iconClass} />
      </Button>
    </div>
  )
}

export { CloseDoneButtons }
