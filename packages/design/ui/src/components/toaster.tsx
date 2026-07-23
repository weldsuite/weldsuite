"use client"

import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "[&]:text-neutral-600 dark:[&]:text-neutral-300",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
        descriptionClassName: "!text-neutral-600 dark:!text-neutral-300",
      }}
      style={{
        // @ts-expect-error - Sonner CSS variables
        "--gray11": "#525252",
      }}
      {...props}
    />
  )
}

export { Toaster }
