import { useState, useEffect } from 'react';
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
  useCreateSocialPost,
  useUpdateSocialPost,
  usePublishSocialPost,
  useScheduleSocialPost,
  useCreateSocialMedia,
} from '@/hooks/queries/use-social-queries';
import type { SocialAccount, SocialMedia } from '@weldsuite/app-api-client/domains/social';

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

const platformEmoji: Record<string, string> = {
  facebook: '📘',
  instagram: '📸',
  twitter: '🐦',
  linkedin: '💼',
  tiktok: '🎵',
};

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

  const createPost = useCreateSocialPost();
  const updatePost = useUpdateSocialPost();
  const publishPost = usePublishSocialPost();
  const schedulePost = useScheduleSocialPost();
  const createMedia = useCreateSocialMedia();

  const accounts = accountsData?.data || [];
  const mediaItems = mediaData?.data || [];
  const timezones = (timezonesData?.data as string[] | undefined) || [];

  useEffect(() => {
    if (editPost) {
      setContent(editPost.content || '');
      setSelectedAccountIds(editPost.accountIds || []);
      setSelectedMediaIds(editPost.mediaIds || []);
      if (editPost.scheduledAt) {
        setScheduleMode(true);
        setScheduledAt(editPost.scheduledAt.slice(0, 16));
      }
      setTimezone(editPost.timezone || '');
    } else {
      setContent('');
      setSelectedAccountIds(defaultAccountIds || []);
      setSelectedMediaIds([]);
      setScheduleMode(false);
      setScheduledAt('');
      setTimezone('');
    }
  }, [editPost, defaultAccountIds, open]);

  const toggleAccount = (id: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

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
    try {
      let postId = editPost?.id;
      if (!postId) {
        const res = await createPost.mutateAsync(buildPostData('draft'));
        postId = res.data?.id;
      } else {
        await updatePost.mutateAsync({ id: postId, ...buildPostData('scheduled') });
      }
      if (postId) {
        await schedulePost.mutateAsync({ id: postId, scheduledAt: new Date(scheduledAt).toISOString(), timezone: timezone || undefined });
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
            <div className="space-y-2">
              <Label>{t.social.accounts.connectedAccounts}</Label>
              <div className="flex flex-wrap gap-2">
                {accounts.map((account: SocialAccount) => (
                  <label
                    key={account.id}
                    className="flex items-center gap-1.5 cursor-pointer text-sm"
                  >
                    <Checkbox
                      checked={selectedAccountIds.includes(account.id)}
                      onCheckedChange={() => toggleAccount(account.id)}
                    />
                    <span>
                      {platformEmoji[account.platform] || '🌐'} {account.name}
                    </span>
                  </label>
                ))}
              </div>
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
              {timezones.length > 0 && (
                <div className="space-y-1.5">
                  <Label>{t.social.settings.defaultTimezone}</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger>
                      <SelectValue placeholder={st('sweep.miscA.composerDialog.selectTimezone')} />
                    </SelectTrigger>
                    <SelectContent>
                      {timezones.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
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
