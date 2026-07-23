"use client"

import * as React from "react"
import { cn } from "../lib/utils"

interface TypingIndicatorProps {
  className?: string
}

export function TypingIndicator({ className }: TypingIndicatorProps) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <span className="animate-bounce h-2 w-2 rounded-full bg-current opacity-75 [animation-delay:-0.3s]" />
      <span className="animate-bounce h-2 w-2 rounded-full bg-current opacity-75 [animation-delay:-0.15s]" />
      <span className="animate-bounce h-2 w-2 rounded-full bg-current opacity-75" />
    </div>
  )
}

export function StreamingCursor({ className }: { className?: string }) {
  return (
    <span 
      className={cn(
        "inline-block w-[2px] h-4 bg-current animate-pulse ml-0.5 align-text-bottom",
        className
      )} 
    />
  )
}