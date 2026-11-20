/**
 * Where an alert or a scheduled report goes: members by email, an in-app
 * notification, a Slack incoming webhook (write-only: shown as "set", then
 * kept, replaced or removed) and a WeldChat channel. A controlled field
 * group over `ChannelsDraft` (`lib/channels.ts`).
 */

import { useAppAccess } from '@/hooks/use-app-access';
import { useChannels } from '@/hooks/queries/use-weldchat-queries';
import { PANEL_MAX_EMAIL_RECIPIENTS, type PanelDeliveryReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { Button } from '@weldsuite/ui/components/button';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import { activeChannels, channelsProblem, type ChannelsDraft } from '../lib/channels';
import type { PanelDeliveryChannelsDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { useMembers } from './use-members';

const NO_CHANNEL = '__none__';

interface DeliveryChannelsFieldsProps {
  value: ChannelsDraft;
  onChange: (value: ChannelsDraft) => void;
  disabled?: boolean;
  /** Show the "choose at least one" and invalid-URL messages (after a submit attempt). */
  showErrors?: boolean;
}

export function DeliveryChannelsFields({ value, onChange, disabled, showErrors }: Readonly<DeliveryChannelsFieldsProps>) {
  const { t, format } = useI18n();
  const tch = t.weldpanel.collab.channels;
  const { members } = useMembers();
  const { isInstalled: chatInstalled } = useAppAccess('weldchat');
  const { data: chatChannels } = useChannels(chatInstalled);
  const set = (patch: Partial<ChannelsDraft>) => onChange({ ...value, ...patch });
  const problem = channelsProblem(value);
  const memberOptions = members.map((m) => ({ value: m.userId, label: m.name || m.email || m.userId }));

  return (
    <fieldset className="grid gap-4" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{tch.title}</legend>
      <div className="grid gap-1.5">
        <Label htmlFor="weldpanel-channels-email">{tch.emailLabel}</Label>
        <MultiSelect
          id="weldpanel-channels-email"
          options={memberOptions}
          value={value.emailUserIds}
          onChange={(ids) => set({ emailUserIds: ids.slice(0, PANEL_MAX_EMAIL_RECIPIENTS) })}
          placeholder={tch.emailPlaceholder}
          searchPlaceholder={tch.emailSearch}
          emptyText={tch.emailEmpty}
          disabled={disabled}
          modal
        />
        <p className="text-xs text-muted-foreground">{format(tch.emailLimit, { max: String(PANEL_MAX_EMAIL_RECIPIENTS) })}</p>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor="weldpanel-channels-inapp">{tch.inAppLabel}</Label>
          <p className="text-xs text-muted-foreground">{tch.inAppHint}</p>
        </div>
        <Switch id="weldpanel-channels-inapp" checked={value.inApp} onCheckedChange={(inApp) => set({ inApp })} disabled={disabled} />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="weldpanel-channels-slack">{tch.slackLabel}</Label>
        {value.slackMode === 'keep' || value.slackMode === 'remove' ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 text-muted-foreground">{value.slackMode === 'keep' ? tch.slackSet : tch.slackRemoved}</span>
            {value.slackMode === 'keep' ? (
              <>
                <Button type="button" size="sm" variant="outline" onClick={() => set({ slackMode: 'set', slackUrl: '' })}>
                  {tch.slackReplace}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => set({ slackMode: 'remove' })}>
                  {tch.slackRemove}
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => set({ slackMode: 'keep' })}>
                {tch.slackKeep}
              </Button>
            )}
          </div>
        ) : (
          <Input
            id="weldpanel-channels-slack"
            type="url"
            inputMode="url"
            autoComplete="off"
            value={value.slackUrl}
            placeholder={tch.slackPlaceholder}
            onChange={(event) => set({ slackMode: 'set', slackUrl: event.target.value })}
            aria-invalid={problem === 'slackInvalid' || undefined}
            disabled={disabled}
          />
        )}
        <p className="text-xs text-muted-foreground">{tch.slackHint}</p>
        {problem === 'slackInvalid' && value.slackUrl.trim() !== '' && <InlineError>{tch.slackInvalid}</InlineError>}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="weldpanel-channels-weldchat">{tch.weldchatLabel}</Label>
        {chatInstalled ? (
          <Select value={value.weldchatChannelId ?? NO_CHANNEL} onValueChange={(next) => set({ weldchatChannelId: next === NO_CHANNEL ? null : next })} disabled={disabled}>
            <SelectTrigger id="weldpanel-channels-weldchat">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CHANNEL}>{tch.weldchatNone}</SelectItem>
              {(chatChannels?.data ?? [])
                .filter((channel) => !channel.isArchived)
                .map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    # {channel.name ?? channel.id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm text-muted-foreground">{tch.weldchatUnavailable}</p>
        )}
      </div>

      {showErrors && problem === 'none' && <InlineError>{tch.noneChosen}</InlineError>}
    </fieldset>
  );
}

/** "3 by email · Slack" for a list row. */
export function ChannelsSummary({ channels }: Readonly<{ channels: PanelDeliveryChannelsDto }>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.collab.channels.summary;
  const parts = activeChannels(channels).map((c) => (c.key === 'email' ? format(ts.email, { count: String(c.count ?? 0) }) : ts[c.key]));
  return <span>{parts.length > 0 ? parts.join(' · ') : ts.none}</span>;
}

/** What each channel did with a test or "send now", for a toast. */
export function deliveryReportText(report: PanelDeliveryReportDto, labels: { ok: string; failed: string; names: Record<string, string>; none: string }, format: (template: string, values: Record<string, string>) => string): string {
  if (report.delivered.length === 0) return labels.none;
  return report.delivered
    .map((d) =>
      d.ok
        ? format(labels.ok, { channel: labels.names[d.channel] ?? d.channel, count: String(d.recipients) })
        : format(labels.failed, { channel: labels.names[d.channel] ?? d.channel, error: d.error ?? '' }),
    )
    .join('\n');
}
