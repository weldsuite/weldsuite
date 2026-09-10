import { useState, useEffect, useMemo, useRef } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
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
  useCreateSocialApproval,
} from '@/hooks/queries/use-social-queries';
import { useFileUpload } from '@/hooks/use-file-upload';
import type { SocialAccount, SocialMedia } from '@weldsuite/app-api-client/domains/social';
import { SocialPlatformIcon } from '@/components/social/social-platform-icon';
import {
  getBrowserTimezone,
  instantToZonedWallClock,
  zonedWallClockToInstant,
  TIMEZONES,
} from '@/lib/timezones';
import { accountsBlockedByMissingMedia } from '../lib/platform-constraints';

interface SocialPost {
  id: string;
  content?: string | null;
  /** Legacy alias used by some callers; prefer `targetAccountIds`. */
  accountIds?: string[] | null;
  targetAccountIds?: string[] | null;
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

function mediaKindFromMime(mimeType: string, fileName: string): 'image' | 'video' | 'gif' {
  if (mimeType === 'image/gif' || fileName.toLowerCase().endsWith('.gif')) return 'gif';
  if (mimeType.startsWith('video/')) return 'video';
  return 'image';
}

export function ComposerDialog({ open, onOpenChange, editPost, defaultAccountIds }: ComposerDialogProps) {
  const { t, format } = useI18n();
  const st = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState('');
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [timezone, setTimezone] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [showUrlField, setShowUrlField] = useState(false);

  const { data: accountsData } = useSocialAccounts();
  const { data: mediaData } = useSocialMedia();
  const { data: timezonesData } = useSocialTimezones();
  const { data: settingsData } = useSocialSettings();

  const createPost = useCreateSocialPost();
  const updatePost = useUpdateSocialPost();
  const publishPost = usePublishSocialPost();
  const schedulePost = useScheduleSocialPost();
  const createMedia = useCreateSocialMedia();
  const createApproval = useCreateSocialApproval();
  const { uploadFile, isUploading } = useFileUpload({
    folder: 'social-media',
    entityType: 'social',
    isPublic: true,
    allowedTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'video/mp4',
      'video/webm',
      'video/quicktime',
    ],
    maxFileSize: 25 * 1024 * 1024,
  });

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
      setSelectedAccountIds(
        editPost.targetAccountIds?.length
          ? editPost.targetAccountIds
          : (editPost.accountIds || []),
      );
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
    setMediaUrl('');
    setShowUrlField(false);
  }, [editPost, defaultAccountIds, open]);

  // Instagram rejects text-only posts at the platform level, and the failure
  // only surfaces AFTER submission as a 500 carrying PostPeer's own message
  // ("Instagram posts require at least one image or video"), by which point the
  // post row exists and the publish slot has been claimed. Catch it here so the
  // user sees which channel is the problem, and the remedy, before publishing.
  //
  // Only publish/schedule are gated — saving a draft stays allowed, since media
  // can be attached later and a draft never reaches Instagram.
  const blockedAccounts = useMemo(
    () => accountsBlockedByMissingMedia(accounts, selectedAccountIds, selectedMediaIds),
    [accounts, selectedAccountIds, selectedMediaIds],
  );

  const mediaRequiredWarning =
    blockedAccounts.length > 0
      ? format(t.social.messages.instagramNeedsMedia, {
          accounts: blockedAccounts
            .map((account: SocialAccount) =>
              account.username ? `@${account.username}` : account.name,
            )
            .join(', '),
        })
      : null;

  const toggleAccount = (id: string, checked: boolean) => {
    setSelectedAccountIds((prev) =>
      checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((v) => v !== id),
    );
  };

  const toggleMedia = (id: string) => {
    setSelectedMediaIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
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
    // Belt and braces alongside the disabled button: the guard must not depend
    // on the button's disabled state staying in sync with this condition.
    if (mediaRequiredWarning) {
      toast.error(mediaRequiredWarning);
      return;
    }
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

  const approvalRequired = Boolean(settingsData?.data?.defaultApprovalRequired);

  /** Save with intended schedule + open an approval request. Approve later auto-schedules. */
  const handleSubmitForApproval = async () => {
    if (!scheduledAt) return;
    if (mediaRequiredWarning) {
      toast.error(mediaRequiredWarning);
      return;
    }
    const instant = zonedWallClockToInstant(scheduledAt, effectiveTimezone);
    if (!instant) {
      toast.error(t.social.messages.invalidScheduleTime);
      return;
    }
    try {
      let postId = editPost?.id;
      const payload = {
        ...buildPostData('pending_approval'),
        scheduledAt: instant.toISOString(),
        timezone: effectiveTimezone,
      };
      if (!postId) {
        const res = await createPost.mutateAsync(payload);
        postId = res.data?.id;
      } else {
        await updatePost.mutateAsync({ id: postId, ...payload });
      }
      if (postId) {
        await createApproval.mutateAsync({
          postId,
          status: 'pending',
          submissionNotes: undefined,
        });
      }
      toast.success(t.social.messages.approvalSubmitted);
      onOpenChange(false);
    } catch {
      toast.error(t.social.posts.submitForApproval);
    }
  };

  const handlePublishNow = async () => {
    if (mediaRequiredWarning) {
      toast.error(mediaRequiredWarning);
      return;
    }
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

  const registerUploadedMedia = async (uploaded: {
    fileName: string;
    url: string;
    mimeType: string;
    fileSize: number;
  }) => {
    const res = await createMedia.mutateAsync({
      fileName: uploaded.fileName,
      url: uploaded.url,
      mimeType: uploaded.mimeType,
      fileSize: uploaded.fileSize,
      mediaType: mediaKindFromMime(uploaded.mimeType, uploaded.fileName),
      status: 'ready',
      thumbnailUrl: uploaded.mimeType.startsWith('image/') ? uploaded.url : undefined,
    });
    const newId = res.data?.id;
    if (newId) setSelectedMediaIds((prev) => [...prev, newId]);
  };

  const handleFilePick = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadFile(file);
        if (!uploaded) {
          toast.error(t.social.media.upload);
          continue;
        }
        await registerUploadedMedia(uploaded);
      }
    } catch {
      toast.error(t.social.media.upload);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleAddMediaUrl = async () => {
    if (!mediaUrl) return;
    try {
      const res = await createMedia.mutateAsync({
        fileName: mediaUrl.split('/').pop() || 'image',
        url: mediaUrl,
        mediaType: 'image',
        status: 'ready',
      });
      const newId = res.data?.id;
      if (newId) setSelectedMediaIds((prev) => [...prev, newId]);
      setMediaUrl('');
    } catch {
      toast.error(t.social.media.upload);
    }
  };

  const isLoading =
    createPost.isPending ||
    updatePost.isPending ||
    publishPost.isPending ||
    schedulePost.isPending ||
    createApproval.isPending ||
    createMedia.isPending ||
    isUploading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editPost ? t.social.posts.editPost : t.social.posts.newPost}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Account selection — checkboxes, not a Popover MultiSelect: Radix
              Dialog traps pointer events so a portaled popover cannot be clicked. */}
          <div className="space-y-1.5">
            <Label>{t.social.accounts.connectedAccounts}</Label>
            {accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {st('sweep.miscA.composerDialog.noAccountsHint')}
              </p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {accounts.map((account: SocialAccount) => {
                  const checked = selectedAccountIds.includes(account.id);
                  const platformName =
                    t.social.accounts.platforms[
                      account.platform as keyof typeof t.social.accounts.platforms
                    ] ?? account.platform;
                  const named = account.username
                    ? `${account.name} (@${account.username})`
                    : account.name;
                  return (
                    <label
                      key={account.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggleAccount(account.id, Boolean(v))}
                      />
                      <SocialPlatformIcon platform={account.platform} colored className="h-4 w-4" />
                      <span className="min-w-0 flex-1 truncate text-sm">{named}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{platformName}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Content */}
          <div className="space-y-1.5">
            <Label>{t.social.posts.content}</Label>
            <Textarea
              placeholder={t.social.compose.whatToShare}
              rows={4}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <p className="text-right text-xs text-muted-foreground">
              {st('sweep.miscA.composerDialog.charactersCount', { count: content.length })}
            </p>
          </div>

          {/* Media */}
          <div className="space-y-2">
            <Label>{t.social.media.title}</Label>
            {mediaItems.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {mediaItems.map((item: SocialMedia) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggleMedia(item.id)}
                    className={`relative flex h-16 w-16 items-center justify-center overflow-hidden rounded border-2 text-xs ${
                      selectedMediaIds.includes(item.id)
                        ? 'border-primary'
                        : 'border-transparent'
                    }`}
                  >
                    {item.thumbnailUrl || item.url ? (
                      <img
                        src={item.thumbnailUrl || item.url || undefined}
                        alt={item.fileName || st('sweep.miscA.composerDialog.mediaAlt')}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-muted-foreground">{item.fileName}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
              multiple
              className="hidden"
              onChange={(e) => void handleFilePick(e.target.files)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {isUploading ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <ImagePlus className="mr-1.5 h-4 w-4" />
                )}
                {isUploading
                  ? st('sweep.miscA.composerDialog.uploading')
                  : st('sweep.miscA.composerDialog.chooseFiles')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowUrlField((v) => !v)}
              >
                {st('sweep.miscA.composerDialog.orPasteUrl')}
              </Button>
            </div>

            {showUrlField && (
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
                  onClick={() => void handleAddMediaUrl()}
                  disabled={!mediaUrl || createMedia.isPending}
                >
                  {st('sweep.miscA.composerDialog.add')}
                </Button>
              </div>
            )}
          </div>

          {/* Sits directly under both remedies — the media picker and the
              add-by-URL field — so the fix is the next thing in reach. */}
          {mediaRequiredWarning && (
            <p role="alert" className="text-sm text-amber-600 dark:text-amber-500">
              {mediaRequiredWarning}
            </p>
          )}

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

        <DialogFooter className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void handleSaveDraft()}
            disabled={isLoading || !content}
          >
            {t.social.posts.saveDraft}
          </Button>
          {scheduleMode && approvalRequired && (
            <Button
              variant="secondary"
              onClick={() => void handleSubmitForApproval()}
              disabled={
                isLoading ||
                !content ||
                !scheduledAt ||
                selectedAccountIds.length === 0 ||
                !!mediaRequiredWarning
              }
            >
              {t.social.posts.submitForApproval}
            </Button>
          )}
          {scheduleMode && !approvalRequired && (
            <Button
              variant="secondary"
              onClick={() => void handleSchedule()}
              disabled={
                isLoading ||
                !content ||
                !scheduledAt ||
                selectedAccountIds.length === 0 ||
                !!mediaRequiredWarning
              }
            >
              {t.social.actions.schedule}
            </Button>
          )}
          <Button
            onClick={() => void handlePublishNow()}
            disabled={
              isLoading || !content || selectedAccountIds.length === 0 || !!mediaRequiredWarning
            }
          >
            {t.social.posts.publishNow}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
