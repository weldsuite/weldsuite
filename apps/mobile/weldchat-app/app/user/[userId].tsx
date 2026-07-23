import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Linking, Alert } from 'react-native';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Phone,
  Video,
  Mail,
  MessageSquare,
  LayoutGrid,
  ChevronLeft,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { appApi } from '@/services/app-api';
import { ChannelView } from '@/components/chat/ChannelView';
import { useCall } from '@/contexts/CallContext';

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  picture?: string | null;
  role?: string;
  status?: string;
}

type Tab = 'details' | 'messages';

function getRoleLabel(role?: string): string {
  return (role || 'MEMBER').toUpperCase();
}

export default function UserDetailsScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);
  const { startCall } = useCall();

  const [member, setMember] = useState<Member | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('details');
  const [dmChannelId, setDmChannelId] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== 'messages' || !userId) return;
    let cancelled = false;
    appApi.chatDm.list().then((res) => {
      if (cancelled) return;
      const dms = res.data ?? [];
      const existing = Array.isArray(dms)
        ? dms.find((d: any) => d.otherUserId === userId || d.name === member?.name)
        : null;
      setDmChannelId(existing?.id ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeTab, userId, member?.name]);

  useEffect(() => {
    let cancelled = false;
    appApi.chatMembers.list().then((res) => {
      if (cancelled) return;
      const members = (res.data ?? []) as unknown as Member[];
      setMember(members.find((m) => m.userId === userId) ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);

  const ensureDmChannelId = async (): Promise<string | null> => {
    try {
      const res = await appApi.chatDm.list();
      const dms = res.data ?? [];
      const existing = Array.isArray(dms)
        ? dms.find((d: any) => d.otherUserId === userId || d.name === member?.name)
        : null;
      if (existing?.id) return existing.id;
      // Create a new DM with this user
      const created = await appApi.chatDm.create({ userIds: [userId as string] });
      return (created as any).data?.id ?? null;
    } catch {
      return null;
    }
  };

  const handleMessage = () => {
    appApi.chatDm.list().then((res) => {
      const dms = res.data ?? [];
      const existing = Array.isArray(dms)
        ? dms.find((d: any) => d.otherUserId === userId || d.name === member?.name)
        : null;
      if (existing?.id) {
        router.replace(`/dm/${existing.id}` as any);
      } else {
        router.push('/new-dm' as any);
      }
    }).catch(() => router.push('/new-dm' as any));
  };

  const handleEmail = () => {
    if (!member?.email) return;
    Linking.openURL(`mailto:${member.email}`).catch(() => Alert.alert('Unable to open mail app'));
  };

  const handleCall = async () => {
    const channelId = await ensureDmChannelId();
    if (!channelId) {
      Alert.alert('Could not start call', 'Unable to open a conversation with this user.');
      return;
    }
    try {
      await startCall(channelId, 'voice', { name: member?.name, avatar: member?.picture, isDirect: true });
    } catch {
      Alert.alert('Call failed', 'Could not connect to the call. Please try again.');
    }
  };

  const handleVideo = async () => {
    const channelId = await ensureDmChannelId();
    if (!channelId) {
      Alert.alert('Could not start call', 'Unable to open a conversation with this user.');
      return;
    }
    try {
      await startCall(channelId, 'video', { name: member?.name, avatar: member?.picture, isDirect: true });
    } catch {
      Alert.alert('Call failed', 'Could not connect to the call. Please try again.');
    }
  };

  const name = member?.name || 'Team member';
  const initial = (member?.name || member?.email || '?').charAt(0).toUpperCase();
  const status = member?.status === 'ACTIVE' ? 'online' : 'offline';
  const localTime = useMemo(() => {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, []);
  const tzOffset = useMemo(() => {
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const h = Math.floor(abs / 60);
    return `GMT${sign}${h}`;
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        {/* Back navigation */}
        <View style={styles.navBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.navBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.6}>
            <ChevronLeft size={22} color={colors.brand} strokeWidth={2.2} />
            <Text style={styles.navBackText}>Back</Text>
          </TouchableOpacity>
        </View>

        {/* Header — single horizontal row */}
        <View style={styles.header}>
          {/* Left: avatar + name */}
          <View style={styles.headerIdentity}>
            <View style={styles.avatarWrap}>
              {member?.picture ? (
                <Image source={{ uri: member.picture }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarText}>{initial}</Text>
                </View>
              )}
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: status === 'online' ? colors.online : colors.offline },
                ]}
              />
            </View>
            <Text style={styles.headerName} numberOfLines={1}>{name}</Text>
          </View>

          {/* Right: action icons */}
          <View style={styles.headerActions}>
            <HeaderIconBtn onPress={handleCall} colors={colors}>
              <Phone size={20} color={colors.textMuted} />
            </HeaderIconBtn>
            <HeaderIconBtn onPress={handleVideo} colors={colors}>
              <Video size={28} color={colors.textMuted} strokeWidth={1.6} />
            </HeaderIconBtn>
            <HeaderIconBtn onPress={handleEmail} colors={colors}>
              <Mail size={20} color={colors.textMuted} />
            </HeaderIconBtn>
          </View>
        </View>

        {/* Tab bar — Details / Messages only */}
        <View style={styles.tabs}>
          <TabBtn label="Details" icon={<LayoutGrid size={16} color={activeTab === 'details' ? colors.textPrimary : colors.textMuted} />} active={activeTab === 'details'} onPress={() => setActiveTab('details')} styles={styles} />
          <TabBtn label="Messages" icon={<MessageSquare size={16} color={activeTab === 'messages' ? colors.textPrimary : colors.textMuted} />} active={activeTab === 'messages'} onPress={() => setActiveTab('messages')} styles={styles} />
        </View>
        <View style={styles.tabsDivider} />

        {/* Messages tab renders an embedded ChannelView */}
        {activeTab === 'messages' ? (
          dmChannelId ? (
            <ChannelView channelId={dmChannelId} hideHeader hideBackButton />
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No conversation with this person yet.</Text>
              <TouchableOpacity style={styles.messageBtn} onPress={handleMessage}>
                <Text style={styles.messageBtnText}>Start conversation</Text>
              </TouchableOpacity>
            </View>
          )
        ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          nestedScrollEnabled
        >
          {activeTab === 'details' && (
            <>
              {/* About */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>About</Text>
                <Text style={styles.aboutEmpty}>No bio yet.</Text>
              </View>

              {/* Info rows */}
              <View style={styles.section}>
                <InfoRow label="Email" styles={styles}>
                  <Text style={styles.infoValue} numberOfLines={1}>{member?.email || '—'}</Text>
                </InfoRow>
                <InfoRow label="Role" styles={styles}>
                  <Text style={styles.infoValue}>{getRoleLabel(member?.role)}</Text>
                </InfoRow>
                <InfoRow label="Timezone" styles={styles}>
                  <Text style={styles.infoValue}>
                    UTC <Text style={styles.timezoneDot}>·</Text>{' '}
                    <Text style={styles.timezoneTime}>{localTime}</Text>{' '}
                    <Text style={styles.timezoneOffset}>({tzOffset})</Text>
                  </Text>
                </InfoRow>
              </View>
            </>
          )}
        </ScrollView>
        )}
      </View>
    </>
  );
}

function HeaderIconBtn({
  onPress,
  children,
  colors: _colors,
}: {
  onPress: () => void;
  children: React.ReactNode;
  colors: ColorScheme;
}) {
  return (
    <TouchableOpacity onPress={onPress} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} style={styles_iconBtn}>
      {children}
    </TouchableOpacity>
  );
}

function TabBtn({
  label,
  icon,
  active,
  onPress,
  styles,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.tabBtn} activeOpacity={0.7}>
      <View style={styles.tabBtnInner}>
        {icon}
        <Text style={[styles.tabBtnLabel, active && styles.tabBtnLabelActive]}>{label}</Text>
        {active && <View style={styles.tabActiveUnderline} />}
      </View>
    </TouchableOpacity>
  );
}

function InfoRow({
  label,
  children,
  styles,
}: {
  label: string;
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <View style={styles.infoValueWrap}>{children}</View>
    </View>
  );
}

const styles_iconBtn = {
  width: 32,
  height: 32,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
};

const makeStyles = (c: ColorScheme, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },

    /* ─── Back nav ─── */
    navBar: {
      paddingTop: topInset + 4,
      paddingHorizontal: 16,
      paddingBottom: 2,
      backgroundColor: c.bgPrimary,
    },
    navBack: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingVertical: 6,
      paddingRight: 8,
      alignSelf: 'flex-start',
    },
    navBackText: { fontSize: 17, color: c.brand, fontWeight: '400' },

    /* ─── Header ─── */
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 4,
      paddingHorizontal: 16,
      paddingBottom: 8,
      gap: 8,
      backgroundColor: c.bgPrimary,
    },
    headerIdentity: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      flexShrink: 1,
      minWidth: 0,
    },
    avatarWrap: { position: 'relative' },
    avatar: { width: 28, height: 28, borderRadius: 10 },
    avatarFallback: { backgroundColor: '#a78bfa', justifyContent: 'center', alignItems: 'center' },
    avatarText: { fontSize: 13, fontWeight: '600', color: '#fff' },
    statusDot: {
      position: 'absolute',
      bottom: -2,
      right: -2,
      width: 10,
      height: 10,
      borderRadius: 5,
      borderWidth: 1.5,
      borderColor: c.bgPrimary,
    },
    headerName: { fontSize: 17, fontWeight: '600', color: c.textPrimary, flexShrink: 1 },

    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      flexShrink: 0,
    },

    /* ─── Tabs ─── */
    tabs: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      paddingTop: 4,
      gap: 20,
    },
    tabBtn: { paddingTop: 10, paddingBottom: 12 },
    tabBtnInner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 4,
    },
    tabBtnLabel: { fontSize: 15, fontWeight: '500', color: c.textMuted },
    tabBtnLabelActive: { color: c.textPrimary, fontWeight: '600' },
    tabActiveUnderline: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: -12,
      height: 2,
      backgroundColor: c.textPrimary,
    },
    tabsDivider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },

    /* ─── Body ─── */
    scrollContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24 + bottomInset },
    section: { marginBottom: 20 },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '500',
      color: c.textPrimary,
      marginBottom: 4,
    },
    aboutEmpty: { fontSize: 14, color: c.textMuted },

    /* Info rows: label-left value-right */
    infoRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingVertical: 4,
      gap: 24,
    },
    infoLabel: { width: 80, fontSize: 14, color: c.textMuted },
    infoValueWrap: { flex: 1 },
    infoValue: { fontSize: 14, color: c.textPrimary },
    timezoneDot: { color: c.textMuted },
    timezoneTime: { fontWeight: '600', fontVariant: ['tabular-nums'] },
    timezoneOffset: { color: c.textMuted },

    emptyState: { paddingVertical: 60, alignItems: 'center', gap: 12 },
    emptyStateText: { fontSize: 14, color: c.textMuted },
    messageBtn: {
      paddingHorizontal: 20,
      paddingVertical: 10,
      backgroundColor: c.brand,
      borderRadius: 10,
    },
    messageBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  });
