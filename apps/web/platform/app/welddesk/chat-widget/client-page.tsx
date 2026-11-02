import { useState, useImperativeHandle, useCallback, forwardRef } from 'react';
import { WidgetInstallationPanel } from '@/components/welddesk/chat-widget/widget-installation-panel';
import { toast } from 'sonner';
import { useUpdateDeskWidget, type DeskWidgetSettings } from '@/hooks/queries/use-desk-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import {
  OfficeHoursSection,
  browserTimeZone,
  defaultOfficeHours,
  invalidOfficeHoursDay,
} from './office-hours-section';
import { IdentityVerificationSection } from './identity-verification-section';

export interface ChatWidgetClientHandle {
  save: () => Promise<void>;
  isSaving: boolean;
}

interface ChatWidgetClientProps {
  initialSettings: DeskWidgetSettings;
  widgetId: string;
}

export const ChatWidgetClient = forwardRef<ChatWidgetClientHandle, ChatWidgetClientProps>(
  function ChatWidgetClient({ initialSettings, widgetId }, ref) {
    const { t } = useI18n();
    const tw = t.helpdesk.chatWidget;
    const tcp = t.helpdesk.chatWidgetPage;
    const updateWidget = useUpdateDeskWidget();
    const [enabled, setEnabled] = useState(initialSettings.enabled);
    const [greeting, setGreeting] = useState(initialSettings.greeting ?? tcp.defaultGreeting);
    const [primaryColor, setPrimaryColor] = useState(initialSettings.branding?.primaryColor ?? '#2563eb');
    const [position, setPosition] = useState<'right' | 'left'>(initialSettings.branding?.position ?? 'right');
    const [officeHours, setOfficeHours] = useState(initialSettings.officeHours ?? defaultOfficeHours());
    const [timezone, setTimezone] = useState(initialSettings.timezone ?? browserTimeZone());
    const [awayMessage, setAwayMessage] = useState(initialSettings.awayMessage ?? '');
    const [expectedReplyTime, setExpectedReplyTime] = useState(initialSettings.expectedReplyTime ?? null);

    const save = useCallback(async () => {
      const invalidDay = officeHours.enabled ? invalidOfficeHoursDay(officeHours) : null;
      if (invalidDay) {
        toast.error(tcp.invalidHours.replace('{day}', tcp.weekdays[invalidDay]));
        return;
      }
      try {
        await updateWidget.mutateAsync({
          widgetId,
          data: {
            enabled,
            greeting,
            branding: {
              primaryColor,
              backgroundColor: initialSettings.branding?.backgroundColor ?? '#ffffff',
              position,
            },
            officeHours,
            timezone,
            awayMessage: awayMessage.trim() || null,
            expectedReplyTime,
          },
        });
        toast.success(tw.settingsSavedSuccess);
      } catch {
        toast.error(tw.settingsSaveFailed);
      }
    }, [
      enabled,
      greeting,
      primaryColor,
      position,
      officeHours,
      timezone,
      awayMessage,
      expectedReplyTime,
      widgetId,
      updateWidget,
      tw,
      tcp,
      initialSettings.branding?.backgroundColor,
    ]);

    useImperativeHandle(ref, () => ({ save, isSaving: updateWidget.isPending }), [save, updateWidget.isPending]);

    return (
      <div className="h-full overflow-y-auto p-6 max-w-3xl space-y-8">
        <section className="space-y-4">
          <h3 className="text-sm font-medium">{tw.settings}</h3>
          <div className="flex items-center justify-between rounded-lg border px-4 py-3">
            <div>
              <p className="text-sm font-medium">{t.helpdesk.settingsClient.chatWidgetEnabled}</p>
              <p className="text-xs text-muted-foreground">{tw.behavior}</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="widget-greeting">{tw.chatViewTitle}</Label>
            <Textarea
              id="widget-greeting"
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              rows={3}
            />
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-medium">{tw.appearance}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="widget-color">{tw.appearance}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="widget-color"
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="h-9 w-14 p-1"
                />
                <Input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tw.availability}</Label>
              <Select value={position} onValueChange={(value) => setPosition(value as 'right' | 'left')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="right">{tcp.positionRight}</SelectItem>
                  <SelectItem value="left">{tcp.positionLeft}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>

        <OfficeHoursSection
          officeHours={officeHours}
          onOfficeHoursChange={setOfficeHours}
          timezone={timezone}
          onTimezoneChange={setTimezone}
          awayMessage={awayMessage}
          onAwayMessageChange={setAwayMessage}
          expectedReplyTime={expectedReplyTime}
          onExpectedReplyTimeChange={setExpectedReplyTime}
        />

        <IdentityVerificationSection widgetId={widgetId} identityRequired={initialSettings.identityRequired ?? false} />

        <section className="space-y-4">
          <h3 className="text-sm font-medium">{tw.installCode}</h3>
          <WidgetInstallationPanel widgetId={widgetId} />
        </section>

        <Button onClick={() => void save()} disabled={updateWidget.isPending}>
          {updateWidget.isPending ? tw.saving : t.helpdesk.actions.save}
        </Button>
      </div>
    );
  },
);
