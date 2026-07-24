"use client"

import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../card"
import { Switch } from "../switch"
import { Button } from "../button"
import { Label } from "../label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select"
import { Separator } from "../separator"

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
  const handleChange = (key: keyof typeof security, value: boolean | number) => {
    onSecurityChange({ ...security, [key]: value })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Security Settings</CardTitle>
          <CardDescription>Manage your security preferences and authentication</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Two-Factor Authentication</Label>
              <p className="text-sm text-muted-foreground">Add an extra layer of security</p>
            </div>
            <Switch
              checked={security.twoFactor}
              onCheckedChange={(v) => handleChange('twoFactor', v)}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Session Timeout</Label>
              <p className="text-sm text-muted-foreground">Auto logout after inactivity</p>
            </div>
            <Select
              value={security.sessionTimeout.toString()}
              onValueChange={(v) => handleChange('sessionTimeout', parseInt(v))}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
                <SelectItem value="120">2 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Login Alerts</Label>
              <p className="text-sm text-muted-foreground">Get notified of new sign-ins</p>
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
          <CardTitle>Password</CardTitle>
          <CardDescription>Change your password or enable password requirements</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline">Change Password</Button>
        </CardContent>
      </Card>
    </div>
  )
}
