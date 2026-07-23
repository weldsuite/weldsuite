"use client"

import * as React from "react"
import { Moon, Sun, Monitor } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"
import { RadioGroup, RadioGroupItem } from "./radio-group"
import { Slider } from "./slider"
import { Label } from "./label"
import { cn } from "../../lib/utils"

interface AppearanceSectionProps {
  theme: "light" | "dark" | "system"
  fontSize: number
  onThemeChange: (theme: "light" | "dark" | "system") => void
  onFontSizeChange: (size: number) => void
}

export function AppearanceSection({
  theme,
  fontSize,
  onThemeChange,
  onFontSizeChange
}: AppearanceSectionProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>Select your preferred theme for the application</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup value={theme} onValueChange={(v: any) => onThemeChange(v)}>
            <div className="grid grid-cols-3 gap-4">
              <label className={cn(
                "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                theme === "light" && "border-primary bg-accent"
              )}>
                <RadioGroupItem value="light" id="light" className="sr-only" />
                <Sun className="h-6 w-6 mb-2" />
                <span className="text-sm font-medium">Light</span>
              </label>
              <label className={cn(
                "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                theme === "dark" && "border-primary bg-accent"
              )}>
                <RadioGroupItem value="dark" id="dark" className="sr-only" />
                <Moon className="h-6 w-6 mb-2" />
                <span className="text-sm font-medium">Dark</span>
              </label>
              <label className={cn(
                "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                theme === "system" && "border-primary bg-accent"
              )}>
                <RadioGroupItem value="system" id="system" className="sr-only" />
                <Monitor className="h-6 w-6 mb-2" />
                <span className="text-sm font-medium">System</span>
              </label>
            </div>
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Font Size</CardTitle>
          <CardDescription>Adjust the font size for better readability</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Size</Label>
              <span className="text-sm text-muted-foreground">{fontSize}%</span>
            </div>
            <Slider
              value={[fontSize]}
              onValueChange={([v]) => onFontSizeChange(v)}
              min={80}
              max={120}
              step={5}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Small</span>
              <span>Default</span>
              <span>Large</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
