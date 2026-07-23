"use client"

import * as React from "react"
import { Command } from "lucide-react"
import { Button } from "./button"
import { cn } from "../lib/utils"

interface CommandTriggerProps {
  onClick?: () => void
  className?: string
  variant?: "default" | "outline" | "ghost" | "secondary"
  size?: "default" | "sm" | "lg" | "icon"
  showShortcut?: boolean
  shortcutText?: string
  position?: "fixed" | "relative"
  fixedPosition?: "bottom-right" | "bottom-left" | "top-right" | "top-left"
}

export function CommandTrigger({
  onClick,
  className,
  variant = "outline",
  size = "default",
  showShortcut = true,
  shortcutText = "⌘K",
  position = "relative",
  fixedPosition = "bottom-right",
}: CommandTriggerProps) {
  const positionClasses = position === "fixed" 
    ? {
        "bottom-right": "fixed bottom-6 right-6 z-50",
        "bottom-left": "fixed bottom-6 left-6 z-50",
        "top-right": "fixed top-6 right-6 z-50",
        "top-left": "fixed top-6 left-6 z-50",
      }[fixedPosition]
    : ""

  return (
    <Button
      variant={variant}
      size={size}
      className={cn(
        "gap-2 shadow-lg",
        positionClasses,
        className
      )}
      onClick={onClick}
    >
      <Command className="h-4 w-4" />
      {size !== "icon" && (
        <>
          <span>Command</span>
          {showShortcut && (
            <kbd className="pointer-events-none ml-2 inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
              {shortcutText}
            </kbd>
          )}
        </>
      )}
    </Button>
  )
}

interface FloatingCommandTriggerProps {
  onOpen: () => void
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left"
}

export function FloatingCommandTrigger({
  onOpen,
  position = "bottom-right",
}: FloatingCommandTriggerProps) {
  return (
    <CommandTrigger
      onClick={onOpen}
      position="fixed"
      fixedPosition={position}
      variant="default"
      size="icon"
      className="shadow-xl hover:scale-110 transition-transform"
    />
  )
}