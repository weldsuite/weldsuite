import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { X, Plus, Check } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import type { SocialAccount, SocialMedia, SocialPost } from '@weldsuite/app-api-client/domains/social';
import { appApi } from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { useI18n } from '@/lib/i18n';
import { useKeyboardSheet } from '@/hooks/use-keyboard-sheet';
import { PLATFORM_META, formatDateTime } from '@/lib/social';

interface ComposeData {
  accounts: SocialAccount[];
  media: SocialMedia[];
  post: SocialPost | null;
}

interface AccountPickerProps {
  accounts: SocialAccount[];
  selectedIds: string[];
  onToggle: (accountId: string) => void;
}

function AccountPicker({ accounts, selectedIds, onToggle }: Readonly<AccountPickerProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  if (!accounts.length) {
    return (
      <Banner variant="info" title={t.compose.noAccountsTitle}>
        {t.compose.noAccountsBody}
      </Banner>
    );
  }
  return (
    <View style={styles.chipWrap}>
      {accounts.map((account) => {
        const meta = PLATFORM_META[account.platform];
        return (
          <Chip
            key={account.id}
            label={`${meta?.label ?? account.platform} · ${account.name}`}
            selected={selectedIds.includes(account.id)}
            onPress={() => onToggle(account.id)}
            leftIcon={<View style={[styles.platformDot, { backgroundColor: meta?.color ?? colors.muted }]} />}
          />
        );
      })}
    </View>
  );
}

interface MediaPickerProps {
  media: SocialMedia[];
  selectedIds: string[];
  onToggle: (mediaId: string) => void;
}

function MediaPicker({ media, selectedIds, onToggle }: Readonly<MediaPickerProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  if (!media.length) {
    return (
      <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
        {t.compose.noMedia}
      </Text>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {media.map((item) => {
        const selected = selectedIds.includes(item.id);
        return (
          <TouchableOpacity
            key={item.id}
            onPress={() => onToggle(item.id)}
            style={[
              styles.mediaTile,
              { borderColor: selected ? colors.info : colors.border, backgroundColor: colors.card },
            ]}
          >
            {item.thumbnailUrl || item.url ? (
              <Image source={{ uri: item.thumbnailUrl || item.url || undefined }} style={styles.mediaImage} />
            ) : (
              <View style={[styles.mediaImage, { backgroundColor: colors.skeleton }]} />
            )}
            {selected && (
              <View style={[styles.mediaCheck, { backgroundColor: colors.info }]}>
                <Check size={12} color="#fff" />
              </View>
            )}
            <Text style={[styles.mediaName, { color: colors.mutedForeground }]} numberOfLines={1}>
              {item.fileName}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

/**
 * Composer — create a new post or edit an existing one (`?id=`).
 *
 * Mirrors the web composer's scope: content + target accounts + media picked
 * from the workspace media library (or added by URL) + optional scheduling.
 * Publishing/scheduling goes through the PostPeer-backed post actions.
 */
export default function ComposeScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const sheetProps = useKeyboardSheet();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editingId = typeof id === 'string' && id.length > 0 ? id : null;

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [initialised, setInitialised] = useState(false);
  const [saving, setSaving] = useState<'draft' | 'schedule' | 'publish' | null>(null);

  // Media-by-URL sheet (parity with the web composer's URL upload)
  const [mediaSheetOpen, setMediaSheetOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaFileName, setMediaFileName] = useState('');
  const [addingMedia, setAddingMedia] = useState(false);

  // Date picker state (two-step on Android: date, then time)
  const [pickerStage, setPickerStage] = useState<'date' | 'time' | null>(null);

  const fetcher = useCallback(async (): Promise<ComposeData> => {
    const [accountsRes, mediaRes, postRes] = await Promise.all([
      appApi.social.accounts.list({ limit: 100 }),
      appApi.social.media.list({ limit: 100 }),
      editingId ? appApi.social.posts.get(editingId) : Promise.resolve(null),
    ]);
    return { accounts: accountsRes.data, media: mediaRes.data, post: postRes?.data ?? null };
  }, [editingId]);

  const { data, loading, error, reload } = useAsyncData(fetcher);

  // Seed the form once when editing an existing post.
  React.useEffect(() => {
    if (!data?.post || initialised) return;
    setTitle(data.post.title ?? '');
    setContent(data.post.content ?? '');
    setSelectedAccountIds(data.post.targetAccountIds ?? []);
    setSelectedMediaIds(data.post.mediaIds ?? []);
    setScheduledAt(data.post.scheduledAt ? new Date(data.post.scheduledAt) : null);
    setInitialised(true);
  }, [data?.post, initialised]);

  const accounts = data?.accounts ?? [];
  const media = data?.media ?? [];

  const canSave = content.trim().length > 0 || title.trim().length > 0;
  const canSend = content.trim().length > 0 && selectedAccountIds.length > 0;

  const toggleAccount = (accountId: string) =>
    setSelectedAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((x) => x !== accountId) : [...prev, accountId],
    );

  const toggleMedia = (mediaId: string) =>
    setSelectedMediaIds((prev) =>
      prev.includes(mediaId) ? prev.filter((x) => x !== mediaId) : [...prev, mediaId],
    );

  const payload = useMemo(
    () => ({
      title: title.trim() || undefined,
      content: content.trim(),
      targetAccountIds: selectedAccountIds,
      mediaIds: selectedMediaIds,
    }),
    [title, content, selectedAccountIds, selectedMediaIds],
  );

  /** Create or update, returning the post id. */
  const persist = async (): Promise<string> => {
    if (editingId) {
      await appApi.social.posts.update(editingId, payload);
      return editingId;
    }
    const res = await appApi.social.posts.create(payload);
    return res.data.id;
  };

  const handleSaveDraft = async () => {
    setSaving('draft');
    try {
      await persist();
      toast.success(t.compose.draftSaved);
      router.back();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.compose.draftFailed);
    } finally {
      setSaving(null);
    }
  };

  const handleSchedule = async () => {
    if (!scheduledAt) return;
    setSaving('schedule');
    try {
      const postId = await persist();
      await appApi.social.posts.schedule(
        postId,
        scheduledAt.toISOString(),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      toast.success(t.compose.scheduled);
      router.back();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.compose.scheduleFailed);
    } finally {
      setSaving(null);
    }
  };

  const handlePublishNow = async () => {
    setSaving('publish');
    try {
      const postId = await persist();
      await appApi.social.posts.publish(postId);
      toast.success(t.compose.published);
      router.back();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.compose.publishFailed);
    } finally {
      setSaving(null);
    }
  };

  const handleAddMediaByUrl = async () => {
    if (!mediaUrl.trim()) return;
    setAddingMedia(true);
    try {
      const res = await appApi.social.media.create({
        fileName: mediaFileName.trim() || mediaUrl.split('/').pop() || 'image',
        url: mediaUrl.trim(),
        mediaType: 'image',
        status: 'ready',
      });
      setSelectedMediaIds((prev) => [...prev, res.data.id]);
      setMediaUrl('');
      setMediaFileName('');
      setMediaSheetOpen(false);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.compose.mediaFailed);
    } finally {
      setAddingMedia(false);
    }
  };

  const onPickerChange = (_event: unknown, picked?: Date) => {
    if (!picked) {
      setPickerStage(null);
      return;
    }
    if (Platform.OS === 'android') {
      if (pickerStage === 'date') {
        // Keep the time from the current selection (or now) and ask for time next.
        const base = scheduledAt ?? new Date();
        const next = new Date(picked);
        next.setHours(base.getHours(), base.getMinutes(), 0, 0);
        setScheduledAt(next);
        setPickerStage('time');
        return;
      }
      setScheduledAt((prev) => {
        const base = prev ?? new Date();
        const next = new Date(base);
        next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
        return next;
      });
      setPickerStage(null);
      return;
    }
    // iOS datetime picker returns the full value in one step.
    setScheduledAt(picked);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === 'ios' ? 16 : insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} accessibilityRole="button" accessibilityLabel={t.common.close}>
          <X size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {editingId ? t.compose.editPost : t.compose.newPost}
        </Text>
        <View style={styles.headerButton} />
      </View>

      {loading && !data ? (
        <View style={styles.loading}>
          <Spinner label={t.common.loading} />
        </View>
      ) : (
        <>
          <KeyboardAwareScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 16 }}
            keyboardShouldPersistTaps="handled"
            bottomOffset={24}
          >
            {error && <Banner variant="error" title={t.compose.loadError}>{error}</Banner>}

            <Input
              label={t.compose.titleLabel}
              placeholder={t.common.optional}
              value={title}
              onChangeText={setTitle}
            />
            <Textarea
              label={t.compose.contentLabel}
              placeholder={t.compose.contentPlaceholder}
              value={content}
              onChangeText={setContent}
            />

            <View>
              <Text style={[styles.label, { color: colors.text }]}>{t.compose.accounts}</Text>
              <AccountPicker accounts={accounts} selectedIds={selectedAccountIds} onToggle={toggleAccount} />
            </View>

            <View>
              <View style={styles.mediaHeader}>
                <Text style={[styles.label, { color: colors.text }]}>{t.compose.media}</Text>
                <TouchableOpacity onPress={() => setMediaSheetOpen(true)} style={styles.addMedia}>
                  <Plus size={16} color={colors.info} />
                  <Text style={[styles.addMediaText, { color: colors.info }]}>{t.compose.addByUrl}</Text>
                </TouchableOpacity>
              </View>
              <MediaPicker media={media} selectedIds={selectedMediaIds} onToggle={toggleMedia} />
            </View>

            <View>
              <Text style={[styles.label, { color: colors.text }]}>{t.compose.schedule}</Text>
              <View style={styles.scheduleRow}>
                <Chip
                  label={scheduledAt ? formatDateTime(scheduledAt.toISOString()) : t.compose.pickDateTime}
                  selected={!!scheduledAt}
                  onPress={() => setPickerStage((stage) => (stage ? null : 'date'))}
                />
                {scheduledAt && <Chip label={t.compose.clear} onPress={() => setScheduledAt(null)} />}
              </View>
              {pickerStage && (
                <DateTimePicker
                  value={scheduledAt ?? new Date(Date.now() + 60 * 60 * 1000)}
                  minimumDate={new Date()}
                  mode={Platform.OS === 'ios' ? 'datetime' : pickerStage}
                  onChange={onPickerChange}
                />
              )}
            </View>
          </KeyboardAwareScrollView>

          <View style={[styles.footer, { borderTopColor: colors.divider, paddingBottom: insets.bottom + 12 }]}>
            <Button
              title={t.compose.saveDraft}
              variant="secondary"
              onPress={handleSaveDraft}
              disabled={!canSave || saving !== null}
              loading={saving === 'draft'}
            />
            {scheduledAt ? (
              <Button
                title={t.compose.scheduleAction}
                onPress={handleSchedule}
                disabled={!canSend || saving !== null}
                loading={saving === 'schedule'}
              />
            ) : (
              <Button
                title={t.compose.publishNow}
                onPress={handlePublishNow}
                disabled={!canSend || saving !== null}
                loading={saving === 'publish'}
              />
            )}
          </View>
        </>
      )}

      <Sheet
        {...sheetProps}
        visible={mediaSheetOpen}
        onClose={() => setMediaSheetOpen(false)}
        title={t.compose.mediaSheetTitle}
      >
        <View style={{ gap: 12 }}>
          <Input
            label={t.compose.imageUrl}
            placeholder="https://…"
            value={mediaUrl}
            onChangeText={setMediaUrl}
            autoCapitalize="none"
            keyboardType="url"
          />
          <Input
            label={t.compose.fileName}
            placeholder={t.common.optional}
            value={mediaFileName}
            onChangeText={setMediaFileName}
          />
          <Button
            title={t.compose.addToLibrary}
            onPress={handleAddMediaByUrl}
            disabled={!mediaUrl.trim() || addingMedia}
            loading={addingMedia}
            fullWidth
          />
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
  },
  headerButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  loading: { paddingTop: 64, alignItems: 'center' },
  label: { fontSize: 15, fontWeight: '600', marginBottom: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  platformDot: { width: 10, height: 10, borderRadius: 5 },
  mediaHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  addMedia: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  addMediaText: { fontSize: 14, fontWeight: '500' },
  mediaTile: { width: 96, borderWidth: 2, borderRadius: 10, padding: 4 },
  mediaImage: { width: '100%', height: 72, borderRadius: 6 },
  mediaCheck: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaName: { fontSize: 11, marginTop: 4 },
  emptyText: { fontSize: 14 },
  scheduleRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 0.5,
    justifyContent: 'flex-end',
  },
});
