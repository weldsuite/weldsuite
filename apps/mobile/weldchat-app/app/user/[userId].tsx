import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  Alert,
  ActionSheetIOS,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@clerk/expo';
import {
  AlertCircle,
  ChartNoAxesGantt,
  ChevronLeft,
  EllipsisVertical,
  HeartHandshake,
  SquareActivity,
  UserX,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { isApiError } from '@weldsuite/api-client/client';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';
import { useCall } from '@/contexts/CallContext';
import { useI18n } from '@/lib/i18n';
import { MemberOverview } from '@/components/member/MemberOverview';
import { MemberCommon } from '@/components/member/MemberCommon';
import { MemberActivity } from '@/components/member/MemberActivity';
import { PanelEmptyState } from '@/components/member/PropertyRow';
import {
  fetchMemberPresence,
  fetchMemberProfile,
  type MemberPresence,
  type MemberProfile,
} from '@/lib/member/api';

/** The profile fetch's outcome — distinct from `loading` so a gone member
 *  (404) and a transient failure render different fallbacks instead of both
 *  leaving the screen on its skeleton forever. */
type ProfileState = 'loading' | 'ready' | 'notFound' | 'error';

type MemberTab = 'overview' | 'common' | 'activity';

// tailwind green-500 / orange-500 / red-500 / yellow-500 / gray-400, as the
// platform's StatusDot.
const PRESENCE_COLORS: Record<MemberPresence['status'], string> = {
  online: '#22C55E',
  busy: '#F97316',
  dnd: '#EF4444',
  away: '#EAB308',
  offline: '#9CA3AF',
};

/**
 * A team member's details, laid out like the platform's team-member panel:
 * a header (back, avatar with presence, name + custom status, "⋮" actions)
 * and Overview / Common / Activity tabs.
 */
export default function UserDetailsScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const { userId: viewerId } = useAuth();
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);
  const { startCall } = useCall();

  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [presence, setPresence] = useState<MemberPresence | null>(null);
  const [activeTab, setActiveTab] = useState<MemberTab>('overview');
  const [profileState, setProfileState] = useState<ProfileState>('loading');
  const [profileRetryKey, setProfileRetryKey] = useState(0);
  const isSelf = !!viewerId && viewerId === userId;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setProfileState('loading');
    fetchMemberProfile(userId)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setProfileState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setProfile(null);
        // The route 404s for a member row that no longer exists (left or
        // removed from the workspace) — tell that apart from a transient
        // failure so only the latter offers a retry.
        setProfileState(isApiError(err) && err.status === 404 ? 'notFound' : 'error');
      });
    fetchMemberPresence(userId)
      .then((p) => !cancelled && setPresence(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId, profileRetryKey]);

  const name = profile
    ? profile.name || profile.email || t.member.fallbackName
    : profileState === 'notFound'
      ? t.member.notFoundTitle
      : profileState === 'error'
        ? t.member.profileLoadFailedTitle
        : '';
  const customStatus =
    presence?.statusText || presence?.statusEmoji
      ? `${presence.statusEmoji ?? ''} ${presence.statusText ?? ''}`.trim()
      : null;

  // The DM with this person, created if there isn't one yet.
  const ensureDm = useCallback(async (): Promise<string | null> => {
    try {
      const res = await appApi.chatDm.list();
      const dms = (res.data ?? []) as unknown as { id: string; otherMembers?: { userId: string }[] }[];
      const existing = dms.find(
        (d) => (d.otherMembers ?? []).length === 1 && d.otherMembers?.[0]?.userId === userId,
      );
      if (existing) return existing.id;
      const created = (await appApi.chatDm.create({ userIds: [userId as string] })) as unknown as {
        data?: { id?: string };
      };
      return created.data?.id ?? null;
    } catch {
      return null;
    }
  }, [userId]);

  const call = useCallback(
    async (kind: 'voice' | 'video') => {
      const channelId = await ensureDm();
      if (!channelId) {
        toast.error(t.member.startCallFailed);
        return;
      }
      try {
        await startCall(channelId, kind, { name, avatar: profile?.picture, isDirect: true });
      } catch {
        toast.error(t.member.startCallFailed);
      }
    },
    [ensureDm, startCall, name, profile?.picture, toast, t],
  );

  const openChat = useCallback(async () => {
    const channelId = await ensureDm();
    if (channelId) router.push({ pathname: '/dm/[channelId]', params: { channelId, name, type: 'dm' } });
  }, [ensureDm, router, name]);

  // Email, call, video and chat all live in the "⋮" menu, as on the platform.
  const openActions = () => {
    const actions: { label: string; run: () => void }[] = [];
    if (profile?.email) {
      const email = profile.email;
      actions.push({ label: t.member.composeEmail, run: () => void Linking.openURL(`mailto:${email}`) });
    }
    if (!isSelf) {
      actions.push(
        { label: t.member.call, run: () => void call('voice') },
        { label: t.member.videoCall, run: () => void call('video') },
        { label: t.member.openChat, run: () => void openChat() },
      );
    }
    if (actions.length === 0) return;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...actions.map((a) => a.label), t.common.cancel], cancelButtonIndex: actions.length },
        (index) => actions[index]?.run(),
      );
    } else {
      Alert.alert(name, undefined, [
        ...actions.map((a) => ({ text: a.label, onPress: a.run })),
        { text: t.common.cancel, style: 'cancel' as const },
      ]);
    }
  };

  const tabs: { id: MemberTab; label: string; icon: typeof ChartNoAxesGantt }[] = [
    { id: 'overview', label: t.member.tabs.overview, icon: ChartNoAxesGantt },
    // Nothing is "in common" with yourself, so that tab is left out.
    ...(isSelf ? [] : [{ id: 'common' as const, label: t.member.tabs.common, icon: HeartHandshake }]),
    { id: 'activity', label: t.member.tabs.activity, icon: SquareActivity },
  ];

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.iconBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t.member.back}
          >
            <ChevronLeft size={16} color={colors.mutedForeground} strokeWidth={2} />
          </TouchableOpacity>

          {profile ? (
            <View style={styles.avatarWrap}>
              {profile.picture ? (
                <Image source={{ uri: profile.picture }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarText}>{(name.trim()[0] ?? '#').toUpperCase()}</Text>
                </View>
              )}
              <View
                style={[styles.statusDot, { backgroundColor: PRESENCE_COLORS[presence?.status ?? 'offline'] }]}
              />
            </View>
          ) : profileState === 'loading' ? (
            <View style={[styles.avatar, styles.skeleton]} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              {profileState === 'notFound' ? (
                <UserX size={14} color={colors.mutedForeground} strokeWidth={2} />
              ) : (
                <AlertCircle size={14} color={colors.destructive} strokeWidth={2} />
              )}
            </View>
          )}

          <View style={styles.titleBlock}>
            {profile || profileState !== 'loading' ? (
              <>
                <Text style={styles.title} numberOfLines={1}>{name}</Text>
                {customStatus ? <Text style={styles.customStatus} numberOfLines={1}>{customStatus}</Text> : null}
              </>
            ) : (
              <View style={styles.titleSkeleton} />
            )}
          </View>

          {profile && (
            <TouchableOpacity
              onPress={openActions}
              style={styles.iconBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t.member.moreActions}
            >
              <EllipsisVertical size={16} color={colors.mutedForeground} strokeWidth={2} />
            </TouchableOpacity>
          )}
        </View>

        {profile ? (
          <>
            <View style={styles.tabs} accessibilityRole="tablist">
              {tabs.map((tab, index) => {
                const active = tab.id === activeTab;
                const Icon = tab.icon;
                return (
                  <TouchableOpacity
                    key={tab.id}
                    style={styles.tab}
                    onPress={() => setActiveTab(tab.id)}
                    activeOpacity={0.6}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                  >
                    <View style={[styles.tabInner, index === 0 && styles.tabFirst]}>
                      <Icon size={16} color={active ? colors.text : colors.mutedForeground} strokeWidth={2} />
                      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{tab.label}</Text>
                    </View>
                    {active && <View style={[styles.tabUnderline, index === 0 && styles.tabUnderlineFirst]} />}
                  </TouchableOpacity>
                );
              })}
            </View>

            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              automaticallyAdjustKeyboardInsets
            >
              {activeTab === 'overview' && <MemberOverview profile={profile} onProfileChange={setProfile} />}
              {activeTab === 'common' && !isSelf && <MemberCommon userId={profile.userId} isSelf={isSelf} />}
              {activeTab === 'activity' && (
                <MemberActivity userId={profile.userId} memberName={profile.name || undefined} />
              )}
            </ScrollView>
          </>
        ) : profileState === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        ) : profileState === 'notFound' ? (
          <View style={styles.center}>
            <PanelEmptyState
              icon={<UserX size={20} color={colors.mutedForeground} />}
              title={t.member.notFoundTitle}
              description={t.member.notFoundDescription}
            />
          </View>
        ) : (
          <View style={styles.center}>
            <PanelEmptyState
              icon={<AlertCircle size={20} color={colors.destructive} />}
              title={t.member.profileLoadFailedTitle}
              description={t.member.profileLoadFailedDescription}
            />
            <TouchableOpacity
              style={[styles.retryBtn, { borderColor: colors.border }]}
              onPress={() => setProfileRetryKey((n) => n + 1)}
              accessibilityRole="button"
            >
              <Text style={[styles.retryText, { color: colors.text }]}>{t.common.retry}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </>
  );
}

const makeStyles = (c: ThemeColors, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },

    // The panel header: 12pt above, 13pt below, controls 28pt.
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minHeight: 52,
      paddingTop: topInset + 12,
      paddingBottom: 13,
      paddingHorizontal: 16,
    },
    iconBtn: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    avatarWrap: { position: 'relative' },
    avatar: { width: 22, height: 22, borderRadius: 8 },
    avatarFallback: { backgroundColor: c.secondary, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontSize: 10, fontWeight: '500', color: c.text },
    statusDot: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 8,
      height: 8,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: c.background,
    },
    skeleton: { backgroundColor: c.secondary },
    titleBlock: { flex: 1, minWidth: 0 },
    title: { fontSize: 15, fontWeight: '500', lineHeight: 24, color: c.text },
    customStatus: { fontSize: 12, color: c.mutedForeground },
    titleSkeleton: { width: 128, height: 16, borderRadius: 4, backgroundColor: c.secondary },

    // Tab strip: icon + label, the active tab underlined in the text colour.
    tabs: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 8 },
    tab: { paddingBottom: 8 },
    tabInner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 4 },
    tabFirst: { marginLeft: -8 },
    tabLabel: { fontSize: 14, fontWeight: '500', color: c.mutedForeground },
    tabLabelActive: { color: c.text },
    tabUnderline: { position: 'absolute', bottom: -1, left: 8, right: 8, height: 2, backgroundColor: c.text },
    tabUnderlineFirst: { left: 0 },

    body: { flex: 1 },
    bodyContent: { paddingBottom: 24 + bottomInset },

    // Fills the tab/body region in place of the skeleton for a not-found or
    // failed profile fetch, as channel-info's load-failed state does.
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
    retryBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
    retryText: { fontSize: 15, fontWeight: '600' },
  });
