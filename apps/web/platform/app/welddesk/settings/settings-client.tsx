
import { useState, useEffect } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Moon, Sun, Monitor, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useUpdateNotificationSettings,
  useUpdateTicketSettings,
  useUpdateSatisfactionSettings,
  useUpdateAutomationSettings,
  type HelpdeskSettingsData,
  type NotificationSettings,
  type TicketSettingsData,
  type SatisfactionSettingsData,
  type AutomationSettingsData,
} from '@/hooks/queries/use-helpdesk-queries';

interface SettingsClientProps {
  initialSettings: HelpdeskSettingsData;
}

export function SettingsClient({ initialSettings }: SettingsClientProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.helpdesk.settingsClient;
  const { theme, setTheme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const updateNotificationsMutation = useUpdateNotificationSettings();
  const updateTicketsMutation = useUpdateTicketSettings();
  const updateSatisfactionMutation = useUpdateSatisfactionSettings();
  const updateAutomationMutation = useUpdateAutomationSettings();

  const [notifications, setNotifications] = useState<NotificationSettings>(
    initialSettings.notifications
  );

  const [tickets, setTickets] = useState<TicketSettingsData>(
    initialSettings.tickets || {
      autoAssignment: false,
      assignmentStrategy: 'round_robin',
    }
  );

  const [satisfaction, setSatisfaction] = useState<SatisfactionSettingsData>(
    initialSettings.satisfaction || {
      enableSurveys: false,
      sendAfterResolution: true,
      delayMinutes: 5,
      thankYouMessage: 'Thanks for chatting with us!',
    }
  );

  const [automation, setAutomation] = useState<AutomationSettingsData>(
    initialSettings.automation || {
      enabled: true,
      slaBreachAction: 'escalate_and_notify',
      priorityAlertThreshold: ['urgent', 'high'],
    }
  );

  const [compactMode, setCompactMode] = useState(initialSettings.appearance.compactMode);
  const [animations, setAnimations] = useState(initialSettings.appearance.enableAnimations);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
  };

  const handleNotificationChange = (key: keyof NotificationSettings, value: boolean) => {
    setNotifications(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const isSaving = updateNotificationsMutation.isPending ||
    updateTicketsMutation.isPending ||
    updateSatisfactionMutation.isPending ||
    updateAutomationMutation.isPending;

  const handleSave = async () => {
    const promises: Promise<unknown>[] = [];
    promises.push(
      new Promise((resolve, reject) =>
        updateNotificationsMutation.mutate(notifications, { onSuccess: resolve, onError: reject })
      )
    );
    promises.push(
      new Promise((resolve, reject) =>
        updateTicketsMutation.mutate(tickets, { onSuccess: resolve, onError: reject })
      )
    );
    promises.push(
      new Promise((resolve, reject) =>
        updateSatisfactionMutation.mutate(satisfaction, { onSuccess: resolve, onError: reject })
      )
    );
    promises.push(
      new Promise((resolve, reject) =>
        updateAutomationMutation.mutate(automation, { onSuccess: resolve, onError: reject })
      )
    );

    try {
      await Promise.all(promises);
      toast.success(t.helpdesk.settingsPage.settingsSaved);
      setHasChanges(false);
    } catch {
      toast.error(t.helpdesk.settingsPage.failedToSaveSomeSettings);
    }
  };

  const handleCancel = () => {
    setNotifications(initialSettings.notifications);
    setTickets(initialSettings.tickets || { autoAssignment: false, assignmentStrategy: 'round_robin' });
    setSatisfaction(initialSettings.satisfaction || { enableSurveys: false, sendAfterResolution: true });
    setAutomation(initialSettings.automation || { enabled: true, slaBreachAction: 'escalate_and_notify' });
    setCompactMode(initialSettings.appearance.compactMode);
    setAnimations(initialSettings.appearance.enableAnimations);
    setHasChanges(false);
  };

  if (!mounted) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto py-10 px-4">
          <div className="h-96 animate-pulse">
            <div className="h-6 bg-muted rounded w-1/4 mb-4" />
            <div className="h-4 bg-muted rounded w-1/2 mb-8" />
            <div className="h-64 bg-muted rounded" />
          </div>
        </div>
      </div>
    );
  }

  const currentTheme = theme === 'system' ? systemTheme : theme;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="border-b flex-shrink-0">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold">{ts.title}</h1>
              <p className="text-sm text-muted-foreground">
                {ts.description}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancel}
                disabled={!hasChanges || isSaving}
              >
                {ts.cancel}
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!hasChanges || isSaving}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    {ts.saving}
                  </>
                ) : (
                  ts.save
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto py-10 px-4">

          {/* ── Auto-Assignment ── */}
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{ts.autoAssignmentSection}</h2>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.enableAutoAssignment}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.enableAutoAssignmentDesc}
                </p>
              </div>
              <Switch
                checked={tickets.autoAssignment || false}
                onCheckedChange={(checked) => {
                  setTickets(prev => ({ ...prev, autoAssignment: checked }));
                  setHasChanges(true);
                }}
              />
            </div>

            {tickets.autoAssignment && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">{ts.assignmentStrategy}</Label>
                <Select
                  value={tickets.assignmentStrategy || 'round_robin'}
                  onValueChange={(value) => {
                    setTickets(prev => ({ ...prev, assignmentStrategy: value as TicketSettingsData['assignmentStrategy'] }));
                    setHasChanges(true);
                  }}
                >
                  <SelectTrigger className="h-9 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="round_robin">{ts.roundRobin}</SelectItem>
                    <SelectItem value="least_busy">{ts.leastBusy}</SelectItem>
                    <SelectItem value="manual">{ts.manual}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* ── Customer Satisfaction ── */}
          <div className="border-t my-8" />

          <div className="space-y-4">
            <h2 className="text-base font-semibold">{ts.customerSatisfactionSection}</h2>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.enableCsatSurveys}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.enableCsatSurveysDesc}
                </p>
              </div>
              <Switch
                checked={satisfaction.enableSurveys || false}
                onCheckedChange={(checked) => {
                  setSatisfaction(prev => ({ ...prev, enableSurveys: checked }));
                  setHasChanges(true);
                }}
              />
            </div>

            {satisfaction.enableSurveys && (
              <>
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{ts.sendAfterResolution}</p>
                    <p className="text-sm text-muted-foreground">
                      {ts.sendAfterResolutionDesc}
                    </p>
                  </div>
                  <Switch
                    checked={satisfaction.sendAfterResolution ?? true}
                    onCheckedChange={(checked) => {
                      setSatisfaction(prev => ({ ...prev, sendAfterResolution: checked }));
                      setHasChanges(true);
                    }}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{ts.delayMinutes}</p>
                    <p className="text-sm text-muted-foreground">
                      {ts.delayMinutesDesc}
                    </p>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={60}
                    value={satisfaction.delayMinutes ?? 5}
                    onChange={(e) => {
                      setSatisfaction(prev => ({ ...prev, delayMinutes: parseInt(e.target.value) || 0 }));
                      setHasChanges(true);
                    }}
                    className="w-24 h-9"
                  />
                </div>

                <div className="space-y-2">
                  <Label>{ts.thankYouMessage}</Label>
                  <Input
                    value={satisfaction.thankYouMessage || ''}
                    onChange={(e) => {
                      setSatisfaction(prev => ({ ...prev, thankYouMessage: e.target.value }));
                      setHasChanges(true);
                    }}
                    placeholder={st('sweep.welddesk.settingsClient.thankYouMessagePlaceholder')}
                  />
                </div>
              </>
            )}
          </div>

          {/* ── Automation Triggers ── */}
          <div className="border-t my-8" />

          <div className="space-y-4">
            <h2 className="text-base font-semibold">{ts.automationSection}</h2>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.enableSettingsAutomation}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.enableSettingsAutomationDesc}
                </p>
              </div>
              <Switch
                checked={automation.enabled}
                onCheckedChange={(checked) => {
                  setAutomation(prev => ({ ...prev, enabled: checked }));
                  setHasChanges(true);
                }}
              />
            </div>

            {automation.enabled && (
              <>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">{ts.slaBreachAction}</Label>
                  <Select
                    value={automation.slaBreachAction || 'escalate_and_notify'}
                    onValueChange={(value) => {
                      setAutomation(prev => ({ ...prev, slaBreachAction: value as AutomationSettingsData['slaBreachAction'] }));
                      setHasChanges(true);
                    }}
                  >
                    <SelectTrigger className="h-9 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="escalate_and_notify">{ts.escalateAndNotify}</SelectItem>
                      <SelectItem value="notify_only">{ts.notifyOnly}</SelectItem>
                      <SelectItem value="none">{ts.none}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">{ts.priorityAlertThreshold}</p>
                  <p className="text-xs text-muted-foreground">
                    {ts.priorityAlertThresholdDesc}
                  </p>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={automation.priorityAlertThreshold?.includes('urgent') ?? false}
                        onCheckedChange={(checked) => {
                          const current = automation.priorityAlertThreshold || [];
                          const next = checked
                            ? [...current.filter(v => v !== 'urgent'), 'urgent' as const]
                            : current.filter(v => v !== 'urgent');
                          setAutomation(prev => ({ ...prev, priorityAlertThreshold: next }));
                          setHasChanges(true);
                        }}
                      />
                      <span className="text-sm">{ts.urgent}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={automation.priorityAlertThreshold?.includes('high') ?? false}
                        onCheckedChange={(checked) => {
                          const current = automation.priorityAlertThreshold || [];
                          const next = checked
                            ? [...current.filter(v => v !== 'high'), 'high' as const]
                            : current.filter(v => v !== 'high');
                          setAutomation(prev => ({ ...prev, priorityAlertThreshold: next }));
                          setHasChanges(true);
                        }}
                      />
                      <span className="text-sm">{ts.high}</span>
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── Appearance ── */}
          <div className="border-t my-8" />

          <div className="space-y-4">
            <h2 className="text-base font-semibold">{ts.appearanceSection}</h2>

            <div>
              <p className="text-sm font-medium mb-3">{ts.themeLabel}</p>
              <div className="grid grid-cols-3 gap-3">
                <Button
                  variant="ghost"
                  onClick={() => handleThemeChange('light')}
                  className={cn(
                    "relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 p-3 hover:bg-accent transition-colors",
                    theme === 'light' ? "border-primary bg-accent" : "border-muted-foreground/25"
                  )}
                >
                  {theme === 'light' && (
                    <div className="absolute top-1.5 right-1.5">
                      <Check className="h-3.5 w-3.5 text-primary" />
                    </div>
                  )}
                  <Sun className="h-5 w-5" />
                  <span className="text-xs font-medium">{ts.light}</span>
                </Button>

                <Button
                  variant="ghost"
                  onClick={() => handleThemeChange('dark')}
                  className={cn(
                    "relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 p-3 hover:bg-accent transition-colors",
                    theme === 'dark' ? "border-primary bg-accent" : "border-muted-foreground/25"
                  )}
                >
                  {theme === 'dark' && (
                    <div className="absolute top-1.5 right-1.5">
                      <Check className="h-3.5 w-3.5 text-primary" />
                    </div>
                  )}
                  <Moon className="h-5 w-5" />
                  <span className="text-xs font-medium">{ts.dark}</span>
                </Button>

                <Button
                  variant="ghost"
                  onClick={() => handleThemeChange('system')}
                  className={cn(
                    "relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 p-3 hover:bg-accent transition-colors",
                    theme === 'system' ? "border-primary bg-accent" : "border-muted-foreground/25"
                  )}
                >
                  {theme === 'system' && (
                    <div className="absolute top-1.5 right-1.5">
                      <Check className="h-3.5 w-3.5 text-primary" />
                    </div>
                  )}
                  <Monitor className="h-5 w-5" />
                  <span className="text-xs font-medium">{ts.system}</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {theme === 'light' && ts.lightActive}
                {theme === 'dark' && ts.darkActive}
                {theme === 'system' && ts.systemActive.replace('{theme}', currentTheme ?? '')}
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.compactMode}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.compactModeDesc}
                </p>
              </div>
              <Switch
                checked={compactMode}
                onCheckedChange={(checked) => {
                  setCompactMode(checked);
                  setHasChanges(true);
                }}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.enableAnimations}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.enableAnimationsDesc}
                </p>
              </div>
              <Switch
                checked={animations}
                onCheckedChange={(checked) => {
                  setAnimations(checked);
                  setHasChanges(true);
                }}
              />
            </div>
          </div>

          {/* ── Notifications ── */}
          <div className="border-t my-8" />

          <div className="space-y-4">
            <h2 className="text-base font-semibold">{ts.notificationsSection}</h2>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.emailNotifications}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.emailNotificationsDesc}
                </p>
              </div>
              <Switch
                checked={notifications.emailNotifications}
                onCheckedChange={(checked) => handleNotificationChange('emailNotifications', checked)}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.pushNotifications}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.pushNotificationsDesc}
                </p>
              </div>
              <Switch
                checked={notifications.pushNotifications}
                onCheckedChange={(checked) => handleNotificationChange('pushNotifications', checked)}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.soundNotifications}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.soundNotificationsDesc}
                </p>
              </div>
              <Switch
                checked={notifications.soundNotifications}
                onCheckedChange={(checked) => handleNotificationChange('soundNotifications', checked)}
              />
            </div>
          </div>

          {/* ── Quick Links ── */}
          <div className="border-t my-8" />

          <div className="space-y-4">
            <h2 className="text-base font-semibold">{ts.moreSection}</h2>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.savedReplies}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.savedRepliesDesc}
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/welddesk/settings/saved-replies">{ts.manage}</Link>
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.ticketTypes}</p>
                <p className="text-sm text-muted-foreground">
                  {ts.ticketTypesDesc}
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/welddesk/settings/tickets">{ts.manage}</Link>
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">{ts.chatWidget}</p>
                <p className="text-sm text-muted-foreground">
                  {initialSettings.widgetSettings?.pageChat ? ts.chatWidgetEnabled : ts.chatWidgetDisabled}
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/welddesk/chat-widget">{ts.configure}</Link>
              </Button>
            </div>
          </div>

          <div className="h-12" />
        </div>
      </div>
    </div>
  );
}
