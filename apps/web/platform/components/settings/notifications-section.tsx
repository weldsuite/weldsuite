
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Switch } from "@weldsuite/ui/components/switch"
import { Label } from "@weldsuite/ui/components/label"
import { Separator } from "@weldsuite/ui/components/separator"

interface NotificationPreferences {
  productUpdates: boolean
  securityAlerts: boolean
  marketingEmails: boolean
  desktopNotifications: boolean
  mobileNotifications: boolean
}

interface NotificationsSectionProps {
  notifications: NotificationPreferences
  onNotificationChange: (key: keyof NotificationPreferences, value: boolean) => void
}

function NotificationsSection({
  notifications,
  onNotificationChange,
}: NotificationsSectionProps) {
  const t = useTranslations()
  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.notificationsSection.title')}</h1>
        <p className="text-muted-foreground">{t('sweep.settings.notificationsSection.description')}</p>
      </div>

      <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">{t('sweep.settings.notificationsSection.emailNotifications')}</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="product-updates" className="text-sm font-medium">
                {t('sweep.settings.notificationsSection.productUpdates')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t('sweep.settings.notificationsSection.productUpdatesDescription')}
              </p>
            </div>
            <Switch
              id="product-updates"
              checked={notifications.productUpdates}
              onCheckedChange={(checked) =>
                onNotificationChange("productUpdates", checked)
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="security-alerts" className="text-sm font-medium">
                {t('sweep.settings.notificationsSection.securityAlerts')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t('sweep.settings.notificationsSection.securityAlertsDescription')}
              </p>
            </div>
            <Switch
              id="security-alerts"
              checked={notifications.securityAlerts}
              onCheckedChange={(checked) =>
                onNotificationChange("securityAlerts", checked)
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="marketing-emails" className="text-sm font-medium">
                {t('sweep.settings.notificationsSection.marketingEmails')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t('sweep.settings.notificationsSection.marketingEmailsDescription')}
              </p>
            </div>
            <Switch
              id="marketing-emails"
              checked={notifications.marketingEmails}
              onCheckedChange={(checked) =>
                onNotificationChange("marketingEmails", checked)
              }
            />
          </div>
        </div>
      </div>

      <Separator />

      <div>
        <h3 className="text-lg font-semibold mb-4">{t('sweep.settings.notificationsSection.pushNotifications')}</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="desktop-notif" className="text-sm font-medium">
                {t('sweep.settings.notificationsSection.desktopNotifications')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t('sweep.settings.notificationsSection.desktopNotificationsDescription')}
              </p>
            </div>
            <Switch
              id="desktop-notif"
              checked={notifications.desktopNotifications}
              onCheckedChange={(checked) =>
                onNotificationChange("desktopNotifications", checked)
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mobile-notif" className="text-sm font-medium">
                {t('sweep.settings.notificationsSection.mobileNotifications')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t('sweep.settings.notificationsSection.mobileNotificationsDescription')}
              </p>
            </div>
            <Switch
              id="mobile-notif"
              checked={notifications.mobileNotifications}
              onCheckedChange={(checked) =>
                onNotificationChange("mobileNotifications", checked)
              }
            />
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
