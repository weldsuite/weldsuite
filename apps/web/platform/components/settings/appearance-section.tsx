
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Moon, Sun, Monitor } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card"
import { RadioGroup, RadioGroupItem } from "@weldsuite/ui/components/radio-group"
import { Slider } from "@weldsuite/ui/components/slider"
import { Label } from "@weldsuite/ui/components/label"
import { cn } from "@/lib/utils"

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
  const t = useTranslations()
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('sweep.settings.appearance.theme')}</CardTitle>
          <CardDescription>{t('sweep.settings.appearance.themeDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup value={theme} onValueChange={(v) => onThemeChange(v as "light" | "dark" | "system")}>
            <div className="grid grid-cols-3 gap-2 md:gap-4">
              <label className={cn(
                "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                theme === "light" && "border-primary bg-accent"
              )}>
                <RadioGroupItem value="light" id="light" className="sr-only" />
                <Sun className="h-6 w-6 mb-2" />
                <span className="text-sm font-medium">{t('sweep.settings.appearance.light')}</span>
              </label>
              <label className={cn(
                "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                theme === "dark" && "border-primary bg-accent"
              )}>
                <RadioGroupItem value="dark" id="dark" className="sr-only" />
                <Moon className="h-6 w-6 mb-2" />
                <span className="text-sm font-medium">{t('sweep.settings.appearance.dark')}</span>
              </label>
              <label className={cn(
                "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                theme === "system" && "border-primary bg-accent"
              )}>
                <RadioGroupItem value="system" id="system" className="sr-only" />
                <Monitor className="h-6 w-6 mb-2" />
                <span className="text-sm font-medium">{t('sweep.settings.appearance.system')}</span>
              </label>
            </div>
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('sweep.settings.appearance.fontSize')}</CardTitle>
          <CardDescription>{t('sweep.settings.appearance.fontSizeDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>{t('sweep.settings.appearance.size')}</Label>
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
              <span>{t('sweep.settings.appearance.small')}</span>
              <span>{t('sweep.settings.appearance.default')}</span>
              <span>{t('sweep.settings.appearance.large')}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
