"use client"

import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"
import { Switch } from "./switch"
import { Label } from "./label"
import { Separator } from "./separator"

interface NotificationsSectionProps {
  notifications: {
    email: boolean
    push: boolean
    desktop: boolean
    sound: boolean
  }
  onNotificationsChange: (notifications: {
    email: boolean
    push: boolean
    desktop: boolean
    sound: boolean
  }) => void
}

export function NotificationsSection({
  notifications,
  onNotificationsChange
}: NotificationsSectionProps) {
  const handleChange = (key: keyof typeof notifications, value: boolean) => {
    onNotificationsChange({ ...notifications, [key]: value })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
          <CardDescription>Choose how you want to receive notifications</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Email Notifications</Label>
              <p className="text-sm text-muted-foreground">Receive notifications via email</p>
            </div>
            <Switch
              checked={notifications.email}
              onCheckedChange={(v) => handleChange('email', v)}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Push Notifications</Label>
              <p className="text-sm text-muted-foreground">Receive push notifications on your devices</p>
            </div>
            <Switch
              checked={notifications.push}
              onCheckedChange={(v) => handleChange('push', v)}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Desktop Notifications</Label>
              <p className="text-sm text-muted-foreground">Show notifications on desktop</p>
            </div>
            <Switch
              checked={notifications.desktop}
              onCheckedChange={(v) => handleChange('desktop', v)}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Sound</Label>
              <p className="text-sm text-muted-foreground">Play sound for notifications</p>
            </div>
            <Switch
              checked={notifications.sound}
              onCheckedChange={(v) => handleChange('sound', v)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
