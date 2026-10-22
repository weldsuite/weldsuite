import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@clerk/expo';
import { Check, Hash, LogOut, Lock, Pencil, Trash2, Users, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { isApiError } from '@weldsuite/api-client/client';
import type { ChannelWithMembers } from '@weldsuite/app-api-client/domains/channels';

import { Screen, ScreenHeader, SectionLabel } from '@/components/screen';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { appApi, appApiClient } from '@/services/app-api';

/** The channel row plus the optional `topic` column the shared type omits. */
type ChannelDetails = ChannelWithMembers & { topic?: string | null };

type Busy = 'rename' | 'leave' | 'delete' | null;

/** Same normalisation as the new-channel screen: lowercase, dashes, no symbols. */
function normalizeChannelName(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/g, '-').replaceAll(/[^a-z0-9-]/g, '');
}

export default function ChannelInfoScreen() {
  const { channelId, name: initialName } = useLocalSearchParams<{
    channelId: string;
    name?: string;
  }>();
  const { t, format, plural } = useI18n();
  const { colors } = useTheme();
  const { userId } = useAuth();
  const toast = useToast();
  const router = useRouter();

  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState<Busy>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await appApi.channels.get(channelId);
      setChannel(res.data as ChannelDetails);
    } catch (err) {
      console.error('[WeldChat] Failed to load channel details:', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The API enforces this (owners and admins may rename or delete); it also
  // returns each member's role, which is all the client needs to hide actions
  // the caller would only be refused.
  const myRole = channel?.members.find((m) => m.userId === userId)?.role ?? null;
  const isMember = myRole !== null;
  const isOwner = myRole === 'owner';
  const canManage = myRole === 'owner' || myRole === 'admin';
  const canLeave = isMember && !isOwner;

  const channelName = channel?.name ?? initialName ?? '';
  const memberCount = channel?.memberCount ?? channel?.members.length ?? 0;
  const description = channel?.description || channel?.topic || '';

  // Back to Home, which reloads its channel list when it regains focus.
  const goHome = useCallback(() => {
    router.dismissTo('/(tabs)');
  }, [router]);

  const startRename = () => {
    setDraftName(channel?.name ?? '');
    setEditing(true);
  };

  const submitRename = async () => {
    const next = draftName.trim();
    if (!channel || busy || !next) return;
    if (next === channel.name) {
      setEditing(false);
      return;
    }
    setBusy('rename');
    try {
      await appApi.channels.update(channel.id, { name: next });
      setChannel({ ...channel, name: next });
      setEditing(false);
      toast.success(t.channelInfo.renamed);
    } catch (err) {
      console.error('[WeldChat] Failed to rename channel:', err);
      toast.error(
        isApiError(err) && err.status === 409 ? t.channelInfo.renameTaken : t.channelInfo.renameFailed,
      );
    } finally {
      setBusy(null);
    }
  };

  const leave = async () => {
    if (!channel) return;
    setBusy('leave');
    try {
      await appApiClient.post(`/channels/${channel.id}/members/leave`, {});
      toast.success(format(t.channelInfo.left, { name: channelName }));
      goHome();
    } catch (err) {
      console.error('[WeldChat] Failed to leave channel:', err);
      toast.error(t.channelInfo.leaveFailed);
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!channel) return;
    setBusy('delete');
    try {
      await appApi.channels.delete(channel.id);
      toast.success(t.channelInfo.deleted);
      goHome();
    } catch (err) {
      console.error('[WeldChat] Failed to delete channel:', err);
      toast.error(t.channelInfo.deleteFailed);
      setBusy(null);
    }
  };

  const confirmLeave = () => {
    Alert.alert(format(t.channelInfo.leaveTitle, { name: channelName }), t.channelInfo.leaveBody, [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.channelInfo.leave, style: 'destructive', onPress: () => void leave() },
    ]);
  };

  const confirmDelete = () => {
    Alert.alert(format(t.channelInfo.deleteTitle, { name: channelName }), t.channelInfo.deleteBody, [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.channelInfo.delete, style: 'destructive', onPress: () => void remove() },
    ]);
  };

  const ChannelIcon = channel?.type === 'private' ? Lock : Hash;
  const showActions = canManage || canLeave || isOwner;

  let body: React.ReactNode;
  if (loading && !channel) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  } else if (failed || !channel) {
    body = (
      <View style={styles.center}>
        <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
          {t.channelInfo.loadFailed}
        </Text>
        <TouchableOpacity
          style={[styles.retryBtn, { borderColor: colors.border }]}
          onPress={() => void load()}
          accessibilityRole="button"
        >
          <Text style={[styles.retryText, { color: colors.text }]}>{t.common.retry}</Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <View style={[styles.heroIcon, { backgroundColor: colors.cardBackground }]}>
            <ChannelIcon size={30} color={colors.text} strokeWidth={2.2} />
          </View>
          {editing ? (
            <View style={[styles.renameRow, { borderColor: colors.secondary }]}>
              <Hash size={18} color={colors.muted} />
              <TextInput
                style={[styles.renameInput, { color: colors.text }]}
                value={draftName}
                onChangeText={(text) => setDraftName(normalizeChannelName(text))}
                placeholder={t.channelInfo.renamePlaceholder}
                placeholderTextColor={colors.muted}
                accessibilityLabel={t.channelInfo.renameLabel}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={() => void submitRename()}
              />
              {busy === 'rename' ? (
                <ActivityIndicator size="small" color={BRAND} />
              ) : (
                <>
                  <TouchableOpacity
                    onPress={() => void submitRename()}
                    disabled={!draftName.trim()}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t.common.save}
                  >
                    <Check size={22} color={draftName.trim() ? BRAND : colors.muted} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setEditing(false)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t.common.cancel}
                  >
                    <X size={22} color={colors.muted} />
                  </TouchableOpacity>
                </>
              )}
            </View>
          ) : (
            <Text style={[styles.heroName, { color: colors.text }]} numberOfLines={2}>
              #{channelName}
            </Text>
          )}
          <Text style={[styles.heroType, { color: colors.mutedForeground }]}>
            {channel.type === 'private' ? t.channelInfo.privateChannel : t.channelInfo.publicChannel}
          </Text>
        </View>

        <SectionLabel>{t.channelInfo.description}</SectionLabel>
        <Card style={styles.card}>
          <View style={styles.textRow}>
            <Text
              style={[styles.bodyText, { color: description ? colors.text : colors.mutedForeground }]}
            >
              {description || t.channelInfo.noDescription}
            </Text>
          </View>
        </Card>

        <SectionLabel>{t.channelInfo.members}</SectionLabel>
        <Card style={styles.card}>
          <View style={[styles.textRow, styles.memberRow]}>
            <Users size={20} color={colors.mutedForeground} />
            <Text style={[styles.bodyText, { color: colors.text }]}>
              {plural(memberCount, t.channelInfo.memberCount)}
            </Text>
          </View>
        </Card>

        {showActions ? (
          <>
            <SectionLabel>{t.channelInfo.actions}</SectionLabel>
            <Card style={styles.card}>
              {canManage ? (
                <TouchableOpacity
                  style={[styles.actionRow, { borderBottomColor: colors.border }]}
                  onPress={startRename}
                  disabled={busy !== null}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                >
                  <Pencil size={20} color={colors.text} />
                  <Text style={[styles.actionText, { color: colors.text }]}>{t.channelInfo.rename}</Text>
                </TouchableOpacity>
              ) : null}
              {canLeave ? (
                <TouchableOpacity
                  style={[
                    styles.actionRow,
                    canManage ? { borderBottomColor: colors.border } : styles.actionRowLast,
                  ]}
                  onPress={confirmLeave}
                  disabled={busy !== null}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                >
                  <LogOut size={20} color={colors.destructive} />
                  <Text style={[styles.actionText, { color: colors.destructive }]}>
                    {t.channelInfo.leave}
                  </Text>
                  {busy === 'leave' ? <ActivityIndicator size="small" color={colors.destructive} /> : null}
                </TouchableOpacity>
              ) : null}
              {canManage ? (
                <TouchableOpacity
                  style={[styles.actionRow, styles.actionRowLast]}
                  onPress={confirmDelete}
                  disabled={busy !== null}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                >
                  <Trash2 size={20} color={colors.destructive} />
                  <Text style={[styles.actionText, { color: colors.destructive }]}>
                    {t.channelInfo.delete}
                  </Text>
                  {busy === 'delete' ? <ActivityIndicator size="small" color={colors.destructive} /> : null}
                </TouchableOpacity>
              ) : null}
            </Card>
            {isOwner ? (
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                {t.channelInfo.ownerCannotLeave}
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <Screen header={<ScreenHeader title={t.channelInfo.title} onBack={() => router.back()} />}>
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  errorText: { fontSize: 15, textAlign: 'center' },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  retryText: { fontSize: 15, fontWeight: '600' },
  content: { paddingBottom: 40 },
  hero: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8, gap: 6 },
  heroIcon: {
    width: 68,
    height: 68,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  heroName: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  heroType: { fontSize: 14 },
  renameRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
  },
  renameInput: { flex: 1, fontSize: 17, paddingVertical: 10 },
  card: { marginHorizontal: 16, borderRadius: 16, overflow: 'hidden', paddingVertical: 0 },
  textRow: { paddingHorizontal: 16, paddingVertical: 14 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bodyText: { fontSize: 16, lineHeight: 22 },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionRowLast: { borderBottomWidth: 0 },
  actionText: { flex: 1, fontSize: 16, fontWeight: '500' },
  hint: { fontSize: 13, marginHorizontal: 20, marginTop: 8, lineHeight: 18 },
});
