import { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect, type MultiSelectOption } from '@weldsuite/ui/components/multi-select';
import {
  useSocialAccounts,
  useSocialMedia,
  useSocialTimezones,
  useSocialSettings,
  useCreateSocialPost,
  useUpdateSocialPost,
  usePublishSocialPost,
  useScheduleSocialPost,
  useCreateSocialMedia,
} from '@/hooks/queries/use-social-queries';
import type { SocialAccount, SocialMedia } from '@weldsuite/app-api-client/domains/social';
import { SocialPlatformIcon } from '@/components/social/social-platform-icon';
import {
  getBrowserTimezone,
  instantToZonedWallClock,
  zonedWallClockToInstant,
  TIMEZONES,
} from '@/lib/timezones';

interface SocialPost {
  id: string;
  content?: string | null;
  accountIds?: string[] | null;
  mediaIds?: string[] | null;
  scheduledAt?: string | null;
  timezone?: string | null;
  status?: string | null;
}

interface ComposerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editPost?: SocialPost | null;
  defaultAccountIds?: string[];
}

export function ComposerDialog({ open, onOpenChange, editPost, defaultAccountIds }: ComposerDialogProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const [content, setContent] = useState('');
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [timezone, setTimezone] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaFileName, setMediaFileName] = useState('');

  const { data: accountsData } = useSocialAccounts();
  const { data: mediaData } = useSocialMedia();
  const { data: timezonesData } = useSocialTimezones();
  const { data: settingsData } = useSocialSettings();

  const createPost = useCreateSocialPost();
  const updatePost = useUpdateSocialPost();
  const publishPost = usePublishSocialPost();
  const schedulePost = useScheduleSocialPost();
  const createMedia = useCreateSocialMedia();

  // Memoised because the option list below derives from it — a fresh `[]` every
  // render would rebuild the dropdown options on every keystroke in the editor.
  const accounts = useMemo(() => accountsData?.data || [], [accountsData]);
  const mediaItems = mediaData?.data || [];
  const timezones = useMemo(
    () => (timezonesData?.data as string[] | undefined) || [],
    [timezonesData],
  );

  // The zone must never be unset: the time typed below is read as wall-clock
  // time in it, so an empty value would leave the entered time ambiguous.
  // Workspace default → viewer's own zone.
  const fallbackTimezone = settingsData?.data?.defaultTimezone || getBrowserTimezone();

  // Empty `timezone` state means "the user hasn't picked one", so the fallback
  // still applies — that way a settings fetch that lands after the dialog opens
  // can refine the default instead of being locked out.
  const effectiveTimezone = timezone || fallbackTimezone;

  // Read inside the reset effect without listing it as a dependency: settings
  // resolving mid-edit must not re-run that effect and wipe the draft.
  const fallbackTimezoneRef = useRef(fallbackTimezone);
  fallbackTimezoneRef.current = fallbackTimezone;

  // The selected zone must always be listed, or the Select renders blank — the
  // workspace default or the viewer's own zone can sit outside the API's list.
  const timezoneOptions = useMemo(() => {
    const list = timezones.length > 0 ? timezones : TIMEZONES.map((tz) => tz.id);
    return list.includes(effectiveTimezone) ? list : [effectiveTimezone, ...list];
  }, [timezones, effectiveTimezone]);

  useEffect(() => {
    if (editPost) {
      setContent(editPost.content || '');
      setSelectedAccountIds(editPost.accountIds || []);
      setSelectedMediaIds(editPost.mediaIds || []);
      const postTimezone = editPost.timezone || fallbackTimezoneRef.current;
      if (editPost.scheduledAt) {
        setScheduleMode(true);
        // Render the stored instant as the clock time someone in the post's own
        // zone would read — slicing the raw ISO string would show UTC instead.
        setScheduledAt(instantToZonedWallClock(editPost.scheduledAt, postTimezone));
        // Pin the zone that clock was rendered in, so the two can't drift apart.
        setTimezone(postTimezone);
      } else {
        // Clear rather than leave whatever the previous post set. Today the
        // call sites null `editPost` on close, so this branch is reached with
        // the state already reset — but the branch shouldn't depend on that:
        // an unscheduled post must never inherit a schedule.
        setScheduleMode(false);
        setScheduledAt('');
        setTimezone(editPost.timezone || '');
      }
    } else {
      setContent('');
      setSelectedAccountIds(defaultAccountIds || []);
      setSelectedMediaIds([]);
      setScheduleMode(false);
      setScheduledAt('');
      setTimezone('');
    }
  }, [editPost, defaultAccountIds, open]);

  // The label doubles as the dropdown's search text AND is the only part a
  // screen reader announces (the icon is decorative), so it carries everything
  // that identifies the channel: name, handle, and platform. One brand name
  // routinely exists on several platforms, and searching "linkedin" should find
  // them. The icon stays uncoloured — X and TikTok are pure black and vanish
  // against a dark chip.
  const accountOptions: MultiSelectOption[] = useMemo(
    () =>
      accounts.map((account: SocialAccount) => {
        const platformName = t.social.accounts.platforms[account.platform] ?? account.platform;
        const named = account.username ? `${account.name} (@${account.username})` : account.name;
        return {
          value: account.id,
          label: `${named} · ${platformName}`,
          icon: <SocialPlatformIcon platform={account.platform} />,
        };
      }),
    [accounts, t]
  );

  const toggleMedia = (id: string) => {
    setSelectedMediaIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  };

  const buildPostData = (status: string) => ({
    content,
    accountIds: selectedAccountIds,
    mediaIds: selectedMediaIds,
    status,
  });

  const handleSaveDraft = async () => {
    try {
      if (editPost) {
        await updatePost.mutateAsync({ id: editPost.id, ...buildPostData('draft') });
      } else {
        await createPost.mutateAsync(buildPostData('draft'));
      }
      toast.success(t.social.messages.postCreated);
      onOpenChange(false);
    } catch {
      toast.error(t.social.actions.save);
    }
  };

  const handleSchedule = async () => {
    if (!scheduledAt) return;
    // The input is a bare wall clock; it means what it says in the SELECTED
    // zone, not the browser's. `new Date(scheduledAt)` would silently apply the
    // viewer's own offset and publish at the wrong moment.
    const instant = zonedWallClockToInstant(scheduledAt, effectiveTimezone);
    if (!instant) {
      toast.error(t.social.messages.invalidScheduleTime);
      return;
    }
    try {
      let postId = editPost?.id;
      if (!postId) {
        const res = await createPost.mutateAsync(buildPostData('draft'));
        postId = res.data?.id;
      } else {
        await updatePost.mutateAsync({ id: postId, ...buildPostData('scheduled') });
      }
      if (postId) {
        await schedulePost.mutateAsync({
          id: postId,
          scheduledAt: instant.toISOString(),
          timezone: effectiveTimezone,
        });
      }
      toast.success(t.social.messages.postScheduled);
      onOpenChange(false);
    } catch {
      toast.error(t.social.actions.schedule);
    }
  };

  const handlePublishNow = async () => {
    try {
      let postId = editPost?.id;
      if (!postId) {
        const res = await createPost.mutateAsync(buildPostData('draft'));
        postId = res.data?.id;
      } else {
        await updatePost.mutateAsync({ id: postId, ...buildPostData('draft') });
      }
      if (postId) {
        await publishPost.mutateAsync(postId);
      }
      toast.success(t.social.messages.postPublished);
      onOpenChange(false);
    } catch {
      toast.error(t.social.actions.publish);
    }
  };

  const handleAddMedia = async () => {
    if (!mediaUrl) return;
    try {
      const res = await createMedia.mutateAsync({
        fileName: mediaFileName || mediaUrl.split('/').pop() || 'image',
        url: mediaUrl,
        mediaType: 'image',
      });
      const newId = res.data?.id;
      if (newId) setSelectedMediaIds((prev) => [...prev, newId]);
      setMediaUrl('');
      setMediaFileName('');
    } catch {
      // ignore
    }
  };

  const isLoading =
    createPost.isPending || updatePost.isPending || publishPost.isPending || schedulePost.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editPost ? t.social.posts.editPost : t.social.posts.newPost}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Account selection */}
          {accounts.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="composer-accounts">{t.social.accounts.connectedAccounts}</Label>
              <MultiSelect
                id="composer-accounts"
                options={accountOptions}
                value={selectedAccountIds}
                onChange={setSelectedAccountIds}
                placeholder={t.social.accounts.selectAccounts}
                searchPlaceholder={t.social.accounts.searchAccounts}
                emptyText={t.social.accounts.noAccountsFound}
                maxDisplay={4}
              />
            </div>
          )}

          {/* Content */}
          <div className="space-y-1.5">
            <Label>{t.social.posts.content}</Label>
            <Textarea
              placeholder={t.social.compose.whatToShare}
              rows={4}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <p className="text-xs text-muted-foreground text-right">
              {st('sweep.miscA.composerDialog.charactersCount', { count: content.length })}
            </p>
          </div>

          {/* Media */}
          {mediaItems.length > 0 && (
            <div className="space-y-2">
              <Label>{t.social.media.title}</Label>
              <div className="flex flex-wrap gap-2">
                {mediaItems.map((item: SocialMedia) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggleMedia(item.id)}
                    className={`relative rounded border-2 overflow-hidden w-16 h-16 flex items-center justify-center text-xs ${
                      selectedMediaIds.includes(item.id)
                        ? 'border-primary'
                        : 'border-transparent'
                    }`}
                  >
                    {item.thumbnailUrl || item.url ? (
                      <img
                        src={item.thumbnailUrl || item.url || undefined}
                        alt={item.fileName || st('sweep.miscA.composerDialog.mediaAlt')}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-muted-foreground">{item.fileName}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* URL upload */}
          <div className="space-y-1.5">
            <Label>{t.social.media.upload}</Label>
            <div className="flex gap-2">
              <Input
                placeholder="https://..."
                value={mediaUrl}
                onChange={(e) => setMediaUrl(e.target.value)}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddMedia}
                disabled={!mediaUrl || createMedia.isPending}
              >
                {st('sweep.miscA.composerDialog.add')}
              </Button>
            </div>
          </div>

          {/* Schedule toggle */}
          <div className="flex items-center gap-2">
            <Checkbox
              checked={scheduleMode}
              onCheckedChange={(v) => setScheduleMode(Boolean(v))}
              id="schedule-toggle"
            />
            <Label htmlFor="schedule-toggle">{t.social.posts.schedulePost}</Label>
          </div>

          {scheduleMode && (
            <div className="space-y-3 pl-6">
              <div className="space-y-1.5">
                <Label>{t.social.posts.scheduledFor}</Label>
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </div>
              {/* Always rendered: the zone decides what the time above means,
                  so hiding it when the API list is empty would leave the entered
                  time unexplained. Falls back to the locally derived list. */}
              <div className="space-y-1.5">
                <Label>{t.social.settings.defaultTimezone}</Label>
                <Select value={effectiveTimezone} onValueChange={setTimezone}>
                  <SelectTrigger>
                    <SelectValue placeholder={st('sweep.miscA.composerDialog.selectTimezone')} />
                  </SelectTrigger>
                  <SelectContent>
                    {timezoneOptions.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={handleSaveDraft}
            disabled={isLoading || !content}
          >
            {t.social.posts.saveDraft}
          </Button>
          {scheduleMode && (
            <Button
              variant="secondary"
              onClick={handleSchedule}
              disabled={isLoading || !content || !scheduledAt || selectedAccountIds.length === 0}
            >
              {t.social.actions.schedule}
            </Button>
          )}
          <Button
            onClick={handlePublishNow}
            disabled={isLoading || !content || selectedAccountIds.length === 0}
          >
            {t.social.posts.publishNow}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
