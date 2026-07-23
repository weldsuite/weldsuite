"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ theme: themeProp, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const resolvedTheme = themeProp ?? (theme as ToasterProps["theme"])

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
