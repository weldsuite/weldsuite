
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Badge } from '@weldsuite/ui/components/badge';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { User, Bell, Shield, Palette, Globe, Database, Save } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';

export default function SettingsPage() {
  const st = useTranslations();
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [pushNotifications, setPushNotifications] = useState(true);
  const [twoFactorAuth, setTwoFactorAuth] = useState(false);
  const [autoBackup, setAutoBackup] = useState(true);

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{st('sweep.weldflow.settingsPage.title')}</h1>
        <p className="text-muted-foreground mt-1">{st('sweep.weldflow.settingsPage.subtitle')}</p>
      </div>

      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList>
          <TabsTrigger value="profile">
            <User className="h-4 w-4 mr-0.5" />
            {st('sweep.weldflow.settingsPage.profile')}
          </TabsTrigger>
          <TabsTrigger value="notifications">
            <Bell className="h-4 w-4 mr-0.5" />
            {st('sweep.weldflow.settingsPage.notifications')}
          </TabsTrigger>
          <TabsTrigger value="security">
            <Shield className="h-4 w-4 mr-0.5" />
            {st('sweep.weldflow.settingsPage.security')}
          </TabsTrigger>
          <TabsTrigger value="appearance">
            <Palette className="h-4 w-4 mr-0.5" />
            {st('sweep.weldflow.settingsPage.appearance')}
          </TabsTrigger>
          <TabsTrigger value="integrations">
            <Globe className="h-4 w-4 mr-0.5" />
            {st('sweep.weldflow.settingsPage.integrations')}
          </TabsTrigger>
          <TabsTrigger value="data">
            <Database className="h-4 w-4 mr-0.5" />
            {st('sweep.weldflow.settingsPage.dataAndPrivacy')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <Card>
            <CardHeader>
              <CardTitle>{st('sweep.weldflow.settingsPage.profileInfoTitle')}</CardTitle>
              <CardDescription>{st('sweep.weldflow.settingsPage.profileInfoDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">{st('sweep.weldflow.settingsPage.firstName')}</Label>
                  <Input id="firstName" defaultValue="John" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">{st('sweep.weldflow.settingsPage.lastName')}</Label>
                  <Input id="lastName" defaultValue="Doe" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">{st('sweep.weldflow.settingsPage.email')}</Label>
                <Input id="email" type="email" defaultValue="john.doe@company.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{st('sweep.weldflow.settingsPage.phoneNumber')}</Label>
                <Input id="phone" defaultValue="+1 555-0123" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">{st('sweep.weldflow.settingsPage.role')}</Label>
                <Select defaultValue="sales-manager">
                  <SelectTrigger id="role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sales-rep">{st('sweep.weldflow.settingsPage.salesRep')}</SelectItem>
                    <SelectItem value="sales-manager">{st('sweep.weldflow.settingsPage.salesManager')}</SelectItem>
                    <SelectItem value="account-manager">{st('sweep.weldflow.settingsPage.accountManager')}</SelectItem>
                    <SelectItem value="admin">{st('sweep.weldflow.settingsPage.administrator')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bio">{st('sweep.weldflow.settingsPage.bio')}</Label>
                <Textarea
                  id="bio"
                  placeholder={st('sweep.weldflow.settingsPage.bioPlaceholder')}
                  defaultValue="Sales Manager with 10+ years of experience in B2B software sales."
                />
              </div>
              <Button>
                    <Save className="mr-0.5 h-4 w-4" />
                {st('sweep.weldflow.settingsPage.saveChanges')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle>{st('sweep.weldflow.settingsPage.notificationPrefsTitle')}</CardTitle>
              <CardDescription>{st('sweep.weldflow.settingsPage.notificationPrefsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">{st('sweep.weldflow.settingsPage.emailNotifications')}</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="email-notifications">{st('sweep.weldflow.settingsPage.emailNotifications')}</Label>
                    <p className="text-sm text-muted-foreground">{st('sweep.weldflow.settingsPage.emailNotificationsDesc')}</p>
                  </div>
                  <Switch
                    id="email-notifications"
                    checked={emailNotifications}
                    onCheckedChange={setEmailNotifications}
                  />
                </div>
                <div className="space-y-3 ml-6">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="new-leads">{st('sweep.weldflow.settingsPage.newLeads')}</Label>
                    <Switch id="new-leads" defaultChecked />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="deal-updates">{st('sweep.weldflow.settingsPage.dealUpdates')}</Label>
                    <Switch id="deal-updates" defaultChecked />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="task-reminders">{st('sweep.weldflow.settingsPage.taskReminders')}</Label>
                    <Switch id="task-reminders" defaultChecked />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="weekly-summary">{st('sweep.weldflow.settingsPage.weeklySummary')}</Label>
                    <Switch id="weekly-summary" />
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">{st('sweep.weldflow.settingsPage.pushNotifications')}</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="push-notifications">{st('sweep.weldflow.settingsPage.pushNotifications')}</Label>
                    <p className="text-sm text-muted-foreground">{st('sweep.weldflow.settingsPage.pushNotificationsDesc')}</p>
                  </div>
                  <Switch
                    id="push-notifications"
                    checked={pushNotifications}
                    onCheckedChange={setPushNotifications}
                  />
                </div>
              </div>

              <Button>
                    <Save className="mr-0.5 h-4 w-4" />
                {st('sweep.weldflow.settingsPage.savePreferences')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>{st('sweep.weldflow.settingsPage.securitySettingsTitle')}</CardTitle>
              <CardDescription>{st('sweep.weldflow.settingsPage.securitySettingsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">{st('sweep.weldflow.settingsPage.password')}</h3>
                <div className="space-y-2">
                  <Label htmlFor="current-password">{st('sweep.weldflow.settingsPage.currentPassword')}</Label>
                  <Input id="current-password" type="password" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-password">{st('sweep.weldflow.settingsPage.newPassword')}</Label>
                  <Input id="new-password" type="password" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">{st('sweep.weldflow.settingsPage.confirmNewPassword')}</Label>
                  <Input id="confirm-password" type="password" />
                </div>
                <Button>{st('sweep.weldflow.settingsPage.changePassword')}</Button>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">{st('sweep.weldflow.settingsPage.twoFactorAuth')}</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="2fa">{st('sweep.weldflow.settingsPage.enableTwoFactorAuth')}</Label>
                    <p className="text-sm text-muted-foreground">{st('sweep.weldflow.settingsPage.twoFactorAuthDesc')}</p>
                  </div>
                  <Switch
                    id="2fa"
                    checked={twoFactorAuth}
                    onCheckedChange={setTwoFactorAuth}
                  />
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">{st('sweep.weldflow.settingsPage.activeSessions')}</h3>
                <div className="space-y-2">
                  <div className="flex justify-between items-center p-3 border rounded-lg">
                    <div>
                      <p className="font-medium">{st('sweep.weldflow.settingsPage.currentSession')}</p>
                      <p className="text-sm text-muted-foreground">Windows • Chrome • 192.168.1.1</p>
                    </div>
                    <Badge className="bg-green-100 text-green-800">{st('sweep.weldflow.settingsPage.active')}</Badge>
                  </div>
                </div>
                <Button variant="outline">{st('sweep.weldflow.settingsPage.signOutAllOtherSessions')}</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="appearance">
          <Card>
            <CardHeader>
              <CardTitle>{st('sweep.weldflow.settingsPage.appearanceSettingsTitle')}</CardTitle>
              <CardDescription>{st('sweep.weldflow.settingsPage.appearanceSettingsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="theme">{st('sweep.weldflow.settingsPage.theme')}</Label>
                <Select defaultValue="system">
                  <SelectTrigger id="theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">{st('sweep.weldflow.settingsPage.light')}</SelectItem>
                    <SelectItem value="dark">{st('sweep.weldflow.settingsPage.dark')}</SelectItem>
                    <SelectItem value="system">{st('sweep.weldflow.settingsPage.system')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="language">{st('sweep.weldflow.settingsPage.language')}</Label>
                <Select defaultValue="en">
                  <SelectTrigger id="language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">{st('sweep.weldflow.settingsPage.english')}</SelectItem>
                    <SelectItem value="es">{st('sweep.weldflow.settingsPage.spanish')}</SelectItem>
                    <SelectItem value="fr">{st('sweep.weldflow.settingsPage.french')}</SelectItem>
                    <SelectItem value="de">{st('sweep.weldflow.settingsPage.german')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="date-format">{st('sweep.weldflow.settingsPage.dateFormat')}</Label>
                <Select defaultValue="mm-dd-yyyy">
                  <SelectTrigger id="date-format">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mm-dd-yyyy">MM/DD/YYYY</SelectItem>
                    <SelectItem value="dd-mm-yyyy">DD/MM/YYYY</SelectItem>
                    <SelectItem value="yyyy-mm-dd">YYYY-MM-DD</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="timezone">{st('sweep.weldflow.settingsPage.timezone')}</Label>
                <Select defaultValue="est">
                  <SelectTrigger id="timezone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pst">{st('sweep.weldflow.settingsPage.pacificTime')}</SelectItem>
                    <SelectItem value="mst">{st('sweep.weldflow.settingsPage.mountainTime')}</SelectItem>
                    <SelectItem value="cst">{st('sweep.weldflow.settingsPage.centralTime')}</SelectItem>
                    <SelectItem value="est">{st('sweep.weldflow.settingsPage.easternTime')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button>
                    <Save className="mr-0.5 h-4 w-4" />
                {st('sweep.weldflow.settingsPage.savePreferences')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="integrations">
          <Card>
            <CardHeader>
              <CardTitle>{st('sweep.weldflow.settingsPage.integrationsTitle')}</CardTitle>
              <CardDescription>{st('sweep.weldflow.settingsPage.integrationsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                {[
                  { name: 'Google Calendar', status: 'connected', description: st('sweep.weldflow.settingsPage.integrationGoogleCalendar') },
                  { name: 'Mailchimp', status: 'disconnected', description: st('sweep.weldflow.settingsPage.integrationMailchimp') },
                  { name: 'Slack', status: 'connected', description: st('sweep.weldflow.settingsPage.integrationSlack') },
                  { name: 'Zapier', status: 'disconnected', description: st('sweep.weldflow.settingsPage.integrationZapier') },
                ].map((integration) => (
                  <div key={integration.name} className="flex items-center justify-between p-4 border rounded-lg">
                    <div>
                      <h4 className="font-semibold">{integration.name}</h4>
                      <p className="text-sm text-muted-foreground">{integration.description}</p>
                    </div>
                    {integration.status === 'connected' ? (
                      <Button variant="outline" size="sm">{st('sweep.weldflow.settingsPage.disconnect')}</Button>
                    ) : (
                      <Button size="sm">{st('sweep.weldflow.settingsPage.connect')}</Button>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="data">
          <Card>
            <CardHeader>
              <CardTitle>{st('sweep.weldflow.settingsPage.dataAndPrivacy')}</CardTitle>
              <CardDescription>{st('sweep.weldflow.settingsPage.dataAndPrivacyDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">{st('sweep.weldflow.settingsPage.dataManagement')}</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="auto-backup">{st('sweep.weldflow.settingsPage.automaticBackup')}</Label>
                    <p className="text-sm text-muted-foreground">{st('sweep.weldflow.settingsPage.automaticBackupDesc')}</p>
                  </div>
                  <Switch
                    id="auto-backup"
                    checked={autoBackup}
                    onCheckedChange={setAutoBackup}
                  />
                </div>
                <Button variant="outline">{st('sweep.weldflow.settingsPage.exportAllData')}</Button>
                <Button variant="outline">{st('sweep.weldflow.settingsPage.createManualBackup')}</Button>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">{st('sweep.weldflow.settingsPage.privacy')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="profile-visibility">{st('sweep.weldflow.settingsPage.publicProfile')}</Label>
                    <Switch id="profile-visibility" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="activity-status">{st('sweep.weldflow.settingsPage.showActivityStatus')}</Label>
                    <Switch id="activity-status" defaultChecked />
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-red-600">{st('sweep.weldflow.settingsPage.dangerZone')}</h3>
                <Button variant="destructive">{st('sweep.weldflow.settingsPage.deleteAccount')}</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}