
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card"
import { Switch } from "@weldsuite/ui/components/switch"
import { Button } from "@weldsuite/ui/components/button"
import { Label } from "@weldsuite/ui/components/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weldsuite/ui/components/select"
import { Separator } from "@weldsuite/ui/components/separator"

interface SecuritySectionProps {
  security: {
    twoFactor: boolean
    sessionTimeout: number
    loginAlerts: boolean
  }
  onSecurityChange: (security: {
    twoFactor: boolean
    sessionTimeout: number
    loginAlerts: boolean
  }) => void
}

export function SecuritySection({
  security,
  onSecurityChange
}: SecuritySectionProps) {
  const t = useTranslations()
  const handleChange = (key: keyof typeof security, value: boolean | number) => {
    onSecurityChange({ ...security, [key]: value })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('sweep.settings.securitySection.title')}</CardTitle>
          <CardDescription>{t('sweep.settings.securitySection.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('sweep.settings.securitySection.twoFactor')}</Label>
              <p className="text-sm text-muted-foreground">{t('sweep.settings.securitySection.twoFactorDescription')}</p>
            </div>
            <Switch
              checked={security.twoFactor}
              onCheckedChange={(v) => handleChange('twoFactor', v)}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('sweep.settings.securitySection.sessionTimeout')}</Label>
              <p className="text-sm text-muted-foreground">{t('sweep.settings.securitySection.sessionTimeoutDescription')}</p>
            </div>
            <Select
              value={security.sessionTimeout.toString()}
              onValueChange={(v) => handleChange('sessionTimeout', parseInt(v))}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">{t('sweep.settings.securitySection.minutes15')}</SelectItem>
                <SelectItem value="30">{t('sweep.settings.securitySection.minutes30')}</SelectItem>
                <SelectItem value="60">{t('sweep.settings.securitySection.hour1')}</SelectItem>
                <SelectItem value="120">{t('sweep.settings.securitySection.hours2')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('sweep.settings.securitySection.loginAlerts')}</Label>
              <p className="text-sm text-muted-foreground">{t('sweep.settings.securitySection.loginAlertsDescription')}</p>
            </div>
            <Switch
              checked={security.loginAlerts}
              onCheckedChange={(v) => handleChange('loginAlerts', v)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('sweep.settings.securitySection.password')}</CardTitle>
          <CardDescription>{t('sweep.settings.securitySection.passwordDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline">{t('sweep.settings.securitySection.changePassword')}</Button>
        </CardContent>
      </Card>
    </div>
  )
}
