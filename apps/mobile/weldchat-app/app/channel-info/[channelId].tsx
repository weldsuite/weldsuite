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

type Colors = ReturnType<typeof useTheme>['colors'];
type Strings = ReturnType<typeof useI18n>['t'];
type Permissions = ReturnType<typeof getChannelPermissions>;
type ChannelActions = ReturnType<typeof useChannelActions>;

/** Same normalisation as the new-channel screen: lowercase, dashes, no symbols. */
function normalizeChannelName(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/g, '-').replaceAll(/[^a-z0-9-]/g, '');
}

/** Loads the channel (with members) and exposes a reload for the retry button. */
function useChannelDetails(channelId: string) {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

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

  return { channel, setChannel, loading, failed, load };
}

// The API enforces this (owners and admins may rename or delete); it also
// returns each member's role, which is all the client needs to hide actions
// the caller would only be refused.
function getChannelPermissions(channel: ChannelDetails | null, userId: string | null | undefined) {
  const myRole = channel?.members.find((m) => m.userId === userId)?.role ?? null;
  const isMember = myRole !== null;
  const isOwner = myRole === 'owner';
  const canManage = myRole === 'owner' || myRole === 'admin';
  const canLeave = isMember && !isOwner;
  return { isOwner, canManage, canLeave, showActions: canManage || canLeave || isOwner };
}

/** Rename, leave and delete, each with its own toast and busy flag. */
function useChannelActions(
  channel: ChannelDetails | null,
  setChannel: (next: ChannelDetails) => void,
  channelName: string,
) {
  const { t, format } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState<Busy>(null);

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

  return {
    editing,
    setEditing,
    draftName,
    setDraftName,
    busy,
    startRename,
    submitRename,
    confirmLeave,
    confirmDelete,
  };
}

function RenameRow({
  draftName,
  setDraftName,
  busy,
  onSubmit,
  onCancel,
  colors,
  t,
}: Readonly<{
  draftName: string;
  setDraftName: (name: string) => void;
  busy: Busy;
  onSubmit: () => void;
  onCancel: () => void;
  colors: Colors;
  t: Strings;
}>) {
  const canSave = Boolean(draftName.trim());
  return (
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
        onSubmitEditing={onSubmit}
      />
      {busy === 'rename' ? (
        <ActivityIndicator size="small" color={BRAND} />
      ) : (
        <>
          <TouchableOpacity
            onPress={onSubmit}
            disabled={!canSave}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t.common.save}
          >
            <Check size={22} color={canSave ? BRAND : colors.muted} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onCancel}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t.common.cancel}
          >
            <X size={22} color={colors.muted} />
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

function ChannelHero({
  channel,
  channelName,
  actions,
  colors,
  t,
}: Readonly<{
  channel: ChannelDetails;
  channelName: string;
  actions: ChannelActions;
  colors: Colors;
  t: Strings;
}>) {
  const ChannelIcon = channel.type === 'private' ? Lock : Hash;
  return (
    <View style={styles.hero}>
      <View style={[styles.heroIcon, { backgroundColor: colors.cardBackground }]}>
        <ChannelIcon size={30} color={colors.text} strokeWidth={2.2} />
      </View>
      {actions.editing ? (
        <RenameRow
          draftName={actions.draftName}
          setDraftName={actions.setDraftName}
          busy={actions.busy}
          onSubmit={() => void actions.submitRename()}
          onCancel={() => actions.setEditing(false)}
          colors={colors}
          t={t}
        />
      ) : (
        <Text style={[styles.heroName, { color: colors.text }]} numberOfLines={2}>
          #{channelName}
        </Text>
      )}
      <Text style={[styles.heroType, { color: colors.mutedForeground }]}>
        {channel.type === 'private' ? t.channelInfo.privateChannel : t.channelInfo.publicChannel}
      </Text>
    </View>
  );
}

function ChannelActionsCard({
  permissions,
  actions,
  colors,
  t,
}: Readonly<{
  permissions: Permissions;
  actions: ChannelActions;
  colors: Colors;
  t: Strings;
}>) {
  const { canManage, canLeave, isOwner } = permissions;
  const { busy } = actions;
  return (
    <>
      <SectionLabel>{t.channelInfo.actions}</SectionLabel>
      <Card style={styles.card}>
        {canManage ? (
          <TouchableOpacity
            style={[styles.actionRow, { borderBottomColor: colors.border }]}
            onPress={actions.startRename}
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
            onPress={actions.confirmLeave}
            disabled={busy !== null}
            activeOpacity={0.6}
            accessibilityRole="button"
          >
            <LogOut size={20} color={colors.destructive} />
            <Text style={[styles.actionText, { color: colors.destructive }]}>{t.channelInfo.leave}</Text>
            {busy === 'leave' ? <ActivityIndicator size="small" color={colors.destructive} /> : null}
          </TouchableOpacity>
        ) : null}
        {canManage ? (
          <TouchableOpacity
            style={[styles.actionRow, styles.actionRowLast]}
            onPress={actions.confirmDelete}
            disabled={busy !== null}
            activeOpacity={0.6}
            accessibilityRole="button"
          >
            <Trash2 size={20} color={colors.destructive} />
            <Text style={[styles.actionText, { color: colors.destructive }]}>{t.channelInfo.delete}</Text>
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
  );
}

function ChannelInfoContent({
  channel,
  channelName,
  permissions,
  actions,
}: Readonly<{
  channel: ChannelDetails;
  channelName: string;
  permissions: Permissions;
  actions: ChannelActions;
}>) {
  const { t, plural } = useI18n();
  const { colors } = useTheme();
  const memberCount = channel.memberCount ?? channel.members.length;
  const description = channel.description || channel.topic || '';

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ChannelHero
        channel={channel}
        channelName={channelName}
        actions={actions}
        colors={colors}
        t={t}
      />

      <SectionLabel>{t.channelInfo.description}</SectionLabel>
      <Card style={styles.card}>
        <View style={styles.textRow}>
          <Text style={[styles.bodyText, { color: description ? colors.text : colors.mutedForeground }]}>
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

      {permissions.showActions ? (
        <ChannelActionsCard permissions={permissions} actions={actions} colors={colors} t={t} />
      ) : null}
    </ScrollView>
  );
}

function ChannelInfoLoadFailed({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { t } = useI18n();
  const { colors } = useTheme();
  return (
    <View style={styles.center}>
      <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
        {t.channelInfo.loadFailed}
      </Text>
      <TouchableOpacity
        style={[styles.retryBtn, { borderColor: colors.border }]}
        onPress={onRetry}
        accessibilityRole="button"
      >
        <Text style={[styles.retryText, { color: colors.text }]}>{t.common.retry}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function ChannelInfoScreen() {
  const { channelId, name: initialName } = useLocalSearchParams<{
    channelId: string;
    name?: string;
  }>();
  const { t } = useI18n();
  const { colors } = useTheme();
  const { userId } = useAuth();
  const router = useRouter();

  const { channel, setChannel, loading, failed, load } = useChannelDetails(channelId);
  const permissions = getChannelPermissions(channel, userId);
  const channelName = channel?.name ?? initialName ?? '';
  const actions = useChannelActions(channel, setChannel, channelName);

  let body: React.ReactNode;
  if (loading && !channel) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  } else if (failed || !channel) {
    body = <ChannelInfoLoadFailed onRetry={() => void load()} />;
  } else {
    body = (
      <ChannelInfoContent
        channel={channel}
        channelName={channelName}
        permissions={permissions}
        actions={actions}
      />
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
