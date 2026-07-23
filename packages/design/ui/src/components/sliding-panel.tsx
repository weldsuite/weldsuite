"use client"

import * as React from "react"
import { X } from "lucide-react"
import { cn } from "../lib/utils"
import { Button } from "./button"

interface SlidingPanelProps {
  isOpen: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  className?: string
  position?: "right" | "left"
  width?: string
}

export function SlidingPanel({
  isOpen,
  onClose,
  title,
  description,
  children,
  className,
  position = "right",
  width = "w-[400px]"
}: SlidingPanelProps) {
  return (
    <>
      {/* Overlay */}
      <div
        className={cn(
          "fixed inset-0 bg-black/20 transition-opacity z-50",
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />
      
      {/* Panel */}
      <div
        className={cn(
          "fixed top-0 bottom-0 z-50 bg-background border-l shadow-xl transition-transform duration-300",
          width,
          position === "right" ? "right-0" : "left-0",
          position === "right" 
            ? (isOpen ? "translate-x-0" : "translate-x-full")
            : (isOpen ? "translate-x-0" : "-translate-x-full"),
          className
        )}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b">
            <div>
              <h2 className="text-lg font-semibold">{title}</h2>
              {description && (
                <p className="text-sm text-muted-foreground mt-1">{description}</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          
          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {children}
          </div>
        </div>
      </div>
    </>
  )
}