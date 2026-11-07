import { useEffect, useMemo, useState } from 'react';
import { Bell, Hash, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import {
  MERGE_CHAT_EVENTS,
  type MergeChatEvent,
  type MergeChatSubscriptionDto,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import {
  useCreateMergeChatSubscription,
  useMergeChatSubscriptions,
  useRemoveMergeChatSubscription,
  useUpdateMergeChatSubscription,
} from '@/hooks/queries/use-weldmerge-across-queries';
import { useMergeRepositories, useMergeTeams } from '@/hooks/queries/use-weldmerge-queries';
import { useChannels } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill } from '../lib/format';

const ANY = '__any__';
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** The channels a member can post a WeldMerge subscription to: not archived, not direct messages. */
function usableChannels(raw: unknown): Array<{ id: string; name: string }> {
  const list = (raw as { data?: Array<{ id: string; name?: string; type?: string; isArchived?: boolean }> } | undefined)?.data ?? [];
  return list
    .filter((channel) => channel.name && !channel.isArchived && channel.type !== 'dm' && channel.type !== 'direct')
    .map((channel) => ({ id: channel.id, name: channel.name as string }));
}

function SubscriptionDialog({
  open,
  onOpenChange,
  subscription,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; subscription: MergeChatSubscriptionDto | null }>) {
  const { t } = useI18n();
  const tn = t.weldmerge.across.notifications;
  const editing = subscription !== null;
  const create = useCreateMergeChatSubscription();
  const update = useUpdateMergeChatSubscription();
  const channels = useChannels(open);
  const teams = useMergeTeams();
  const repositories = useMergeRepositories(open);
  const channelRows = useMemo(() => usableChannels(channels.data), [channels.data]);

  const [channelId, setChannelId] = useState('');
  const [teamId, setTeamId] = useState(ANY);
  const [repositoryId, setRepositoryId] = useState(ANY);
  const [events, setEvents] = useState<MergeChatEvent[]>([]);
  const [digestHour, setDigestHour] = useState(9);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChannelId(subscription?.channelId ?? '');
    setTeamId(subscription?.teamId ?? ANY);
    setRepositoryId(subscription?.repositoryId ?? ANY);
    setEvents(subscription?.events ?? ['review_requested', 'checks_failed', 'pull_request_merged']);
    setDigestHour(subscription?.digestHour ?? 9);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when the dialog opens for a subscription
  }, [open, subscription?.id]);

  const toggleEvent = (event: MergeChatEvent, checked: boolean) =>
    setEvents((current) => (checked ? [...current, event] : current.filter((item) => item !== event)));

  const submit = async () => {
    if (!editing && channelId === '') return setError(tn.needChannel);
    if (events.length === 0) return setError(tn.needEvent);
    setError(null);
    const filters = { teamId: teamId === ANY ? null : teamId, repositoryId: repositoryId === ANY ? null : repositoryId };
    try {
      if (subscription) {
        await update.mutateAsync({ id: subscription.id, input: { ...filters, events, digestHour } });
      } else {
        await create.mutateAsync({ channelId, ...filters, events, digestHour });
      }
      toast.success(tn.saved);
      onOpenChange(false);
    } catch {
      toast.error(tn.saveFailed);
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? tn.edit : tn.add}</DialogTitle>
          <DialogDescription>{tn.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!editing && (
            <div className="space-y-1.5">
              <Label>{tn.channel}</Label>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger className="w-full" aria-label={tn.channel}>
                  <SelectValue placeholder={tn.selectChannel} />
                </SelectTrigger>
                <SelectContent>
                  {channelRows.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      # {channel.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{tn.team}</Label>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger className="w-full" aria-label={tn.team}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>{tn.anyTeam}</SelectItem>
                  {(teams.data ?? []).map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{tn.repository}</Label>
              <Select value={repositoryId} onValueChange={setRepositoryId}>
                <SelectTrigger className="w-full" aria-label={tn.repository}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>{tn.anyRepository}</SelectItem>
                  {(repositories.data ?? []).map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{tn.events}</legend>
            {MERGE_CHAT_EVENTS.map((event) => (
              <div key={event} className="flex items-center gap-2">
                <Checkbox
                  id={`merge-chat-event-${event}`}
                  checked={events.includes(event)}
                  onCheckedChange={(checked) => toggleEvent(event, checked === true)}
                />
                <Label htmlFor={`merge-chat-event-${event}`} className="font-normal">
                  {tn.event[event]}
                </Label>
              </div>
            ))}
          </fieldset>
          {events.includes('daily_digest') && (
            <div className="space-y-1.5">
              <Label>{tn.digestHour}</Label>
              <Select value={String(digestHour)} onValueChange={(value) => setDigestHour(Number(value))}>
                <SelectTrigger className="w-40" aria-label={tn.digestHour}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((hour) => (
                    <SelectItem key={hour} value={String(hour)}>
                      {fill(tn.digestHourValue, { hour: String(hour).padStart(2, '0') })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.common.actions.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {editing ? tn.save : tn.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings, Notifications tab: the WeldChat channels that receive WeldMerge
 * updates, each with an optional team and repository filter, the events it
 * gets and the hour of its daily digest. Managing them needs `merge_teams:manage`.
 */
export function NotificationsSection() {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const tn = tm.across.notifications;
  const canManage = useCan('merge_teams:manage');
  const subscriptions = useMergeChatSubscriptions(canManage);
  const channels = useChannels(canManage);
  const teams = useMergeTeams();
  const repositories = useMergeRepositories(canManage);
  const remove = useRemoveMergeChatSubscription();

  const [editing, setEditing] = useState<MergeChatSubscriptionDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<MergeChatSubscriptionDto | null>(null);

  const channelName = useMemo(() => new Map(usableChannels(channels.data).map((channel) => [channel.id, channel.name])), [channels.data]);
  const teamName = useMemo(() => new Map((teams.data ?? []).map((team) => [team.id, team.name])), [teams.data]);
  const repositoryName = useMemo(() => new Map((repositories.data ?? []).map((repo) => [repo.id, repo.fullName])), [repositories.data]);

  if (!canManage) return <p className="text-sm text-muted-foreground">{tn.readOnly}</p>;
  if (subscriptions.isLoading) return <PageLoader fullScreen={false} />;
  if (subscriptions.isError) {
    return <ErrorState message={tn.loadFailed} retryLabel={tm.retry} onRetry={() => void subscriptions.refetch()} />;
  }

  const rows = subscriptions.data ?? [];

  const confirmRemove = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
      toast.success(tn.removed);
    } catch {
      toast.error(tn.removeFailed);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{tn.title}</h2>
          <p className="text-sm text-muted-foreground">{tn.description}</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          {tn.add}
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Bell} title={tn.empty} description={tn.description} />
      ) : (
        <ul className="space-y-3">
          {rows.map((subscription) => (
            <li key={subscription.id}>
              <SectionCard
                title={
                  <span className="flex items-center gap-2">
                    <Hash className="size-4 text-muted-foreground" />
                    {channelName.get(subscription.channelId) ?? tn.unknownChannel}
                  </span>
                }
                action={
                  <span className="flex">
                    <Button variant="ghost" size="icon" className="size-8" aria-label={t.common.actions.edit} onClick={() => setEditing(subscription)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-8" aria-label={tn.remove} onClick={() => setDeleting(subscription)}>
                      <Trash2 />
                    </Button>
                  </span>
                }
              >
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {subscription.teamId ? (teamName.get(subscription.teamId) ?? subscription.teamId) : tn.anyTeam} ·{' '}
                    {subscription.repositoryId
                      ? (repositoryName.get(subscription.repositoryId) ?? subscription.repositoryId)
                      : tn.anyRepository}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {subscription.events.map((event) => (
                      <SoftBadge key={event} tone="neutral">
                        {tn.event[event]}
                        {event === 'daily_digest' ? ` · ${fill(tn.digestHourValue, { hour: String(subscription.digestHour).padStart(2, '0') })}` : ''}
                      </SoftBadge>
                    ))}
                  </div>
                </div>
              </SectionCard>
            </li>
          ))}
        </ul>
      )}

      <SubscriptionDialog open={creating} onOpenChange={setCreating} subscription={null} />
      <SubscriptionDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} subscription={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={fill(tn.removeTitle, { channel: deleting ? (channelName.get(deleting.channelId) ?? tn.unknownChannel) : '' })}
        description={tn.removeDescription}
        confirmLabel={tn.remove}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmRemove}
      />
    </div>
  );
}
