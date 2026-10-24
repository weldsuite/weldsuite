import { useMemo } from 'react';
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
import type {
  DeskExpectedReplyTime,
  DeskOfficeHours,
  DeskWeekday,
} from '@/hooks/queries/use-desk-queries';

export const WEEKDAYS: DeskWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const REPLY_TIMES: DeskExpectedReplyTime[] = ['few_minutes', 'hour', 'few_hours', 'day'];
const NO_REPLY_TIME = 'none';
const DEFAULT_WINDOW = { start: '09:00', end: '17:00' };

/** Monday–Friday 9 to 5: the starting point when a widget has no schedule yet. */
export function defaultOfficeHours(): DeskOfficeHours {
  return {
    enabled: false,
    days: { mon: DEFAULT_WINDOW, tue: DEFAULT_WINDOW, wed: DEFAULT_WINDOW, thu: DEFAULT_WINDOW, fri: DEFAULT_WINDOW },
  };
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The first open weekday whose end isn't after its start, if any. */
export function invalidOfficeHoursDay(officeHours: DeskOfficeHours): DeskWeekday | null {
  return WEEKDAYS.find((day) => {
    const window = officeHours.days[day];
    return window ? window.end <= window.start : false;
  }) ?? null;
}

function timeZones(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  return supported.includes(current) ? supported : [current, ...supported];
}

interface OfficeHoursSectionProps {
  officeHours: DeskOfficeHours;
  onOfficeHoursChange: (next: DeskOfficeHours) => void;
  timezone: string;
  onTimezoneChange: (zone: string) => void;
  awayMessage: string;
  onAwayMessageChange: (message: string) => void;
  expectedReplyTime: DeskExpectedReplyTime | null;
  onExpectedReplyTimeChange: (value: DeskExpectedReplyTime | null) => void;
}

export function OfficeHoursSection({
  officeHours,
  onOfficeHoursChange,
  timezone,
  onTimezoneChange,
  awayMessage,
  onAwayMessageChange,
  expectedReplyTime,
  onExpectedReplyTimeChange,
}: Readonly<OfficeHoursSectionProps>) {
  const { t } = useI18n();
  const tcp = t.helpdesk.chatWidgetPage;
  const zones = useMemo(() => timeZones(timezone), [timezone]);

  const setDay = (day: DeskWeekday, window: { start: string; end: string } | null) =>
    onOfficeHoursChange({ ...officeHours, days: { ...officeHours.days, [day]: window } });

  return (
    <section className="space-y-4" data-testid="chat-widget-office-hours">
      <h3 className="text-sm font-medium">{tcp.officeHours}</h3>
      <div className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
        <div>
          <p className="text-sm font-medium">{tcp.officeHoursEnabled}</p>
          <p className="text-xs text-muted-foreground">{tcp.officeHoursDescription}</p>
        </div>
        <Switch
          checked={officeHours.enabled}
          onCheckedChange={(enabled) => onOfficeHoursChange({ ...officeHours, enabled })}
          aria-label={tcp.officeHoursEnabled}
        />
      </div>

      {officeHours.enabled && (
        <>
          <div className="space-y-2">
            <Label>{tcp.timezone}</Label>
            <Select value={timezone} onValueChange={onTimezoneChange}>
              <SelectTrigger className="sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {zones.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone.replaceAll('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="divide-y rounded-lg border">
            {WEEKDAYS.map((day) => {
              const window = officeHours.days[day] ?? null;
              const invalid = window ? window.end <= window.start : false;
              return (
                <div key={day} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <Switch
                    checked={window !== null}
                    onCheckedChange={(open) => setDay(day, open ? DEFAULT_WINDOW : null)}
                    aria-label={tcp.weekdays[day]}
                  />
                  <span className="w-28 text-sm">{tcp.weekdays[day]}</span>
                  {window ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        value={window.start}
                        onChange={(e) => setDay(day, { ...window, start: e.target.value })}
                        aria-label={`${tcp.weekdays[day]} ${tcp.from}`}
                        className="h-8 w-28"
                      />
                      <span className="text-sm text-muted-foreground">–</span>
                      <Input
                        type="time"
                        value={window.end}
                        onChange={(e) => setDay(day, { ...window, end: e.target.value })}
                        aria-label={`${tcp.weekdays[day]} ${tcp.until}`}
                        aria-invalid={invalid}
                        className={invalid ? 'h-8 w-28 border-destructive' : 'h-8 w-28'}
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">{tcp.closed}</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor="widget-away-message">{tcp.awayMessage}</Label>
        <Textarea
          id="widget-away-message"
          value={awayMessage}
          onChange={(e) => onAwayMessageChange(e.target.value)}
          placeholder={tcp.awayMessagePlaceholder}
          maxLength={1000}
          rows={3}
        />
      </div>

      <div className="space-y-2">
        <Label>{tcp.expectedReplyTime}</Label>
        <Select
          value={expectedReplyTime ?? NO_REPLY_TIME}
          onValueChange={(value) =>
            onExpectedReplyTimeChange(value === NO_REPLY_TIME ? null : (value as DeskExpectedReplyTime))
          }
        >
          <SelectTrigger className="sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_REPLY_TIME}>{tcp.replyTimes.none}</SelectItem>
            {REPLY_TIMES.map((value) => (
              <SelectItem key={value} value={value}>
                {tcp.replyTimes[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{tcp.expectedReplyTimeHint}</p>
      </div>
    </section>
  );
}
