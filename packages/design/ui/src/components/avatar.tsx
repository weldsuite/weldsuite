"use client"

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "../lib/utils"

/**
 * One avatar shape across WeldSuite: the rounded square WeldChat uses, with a
 * corner radius of about a third of the width, so a 20px avatar and an 80px
 * one look alike. Set the size with `className` (`size-5`, `h-7 w-7`, ...) and
 * leave the radius alone; the image and the fallback follow the root's corners.
 */
function Avatar({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 overflow-hidden rounded-[32%]",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({
  className,
  // An avatar sits next to the person's name almost everywhere, so it is
  // decorative unless the caller names it. Without an alt a screen reader
  // reads out the image URL.
  alt = "",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      alt={alt}
      className={cn("aspect-square size-full rounded-[inherit] object-cover", className)}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "bg-muted flex size-full items-center justify-center rounded-[inherit]",
        className
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback }
