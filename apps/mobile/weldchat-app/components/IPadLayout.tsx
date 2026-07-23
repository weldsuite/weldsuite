import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Pressable,
  StyleSheet,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Image as ExpoImage } from 'expo-image';
import {
  Hash,
  Lock,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  PenSquare,
  Settings,
} from 'lucide-react-native';
import { useUser } from '@clerk/expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { appApi } from '@/services/app-api';
import { useChatUserEvents } from '@/hooks/useChatUserEvents';
import { ChannelView } from './chat/ChannelView';

interface Channel {
  id: string;
  name: string;
  type: string;
  unreadCount?: number;
}

interface DmChannel {
  id: string;
  name: string;
  picture?: string | null;
  type: string;
  unreadCount?: number;
  lastMessage?: string;
  lastMessageAt?: string;
}

const SIDEBAR_WIDTH = 320;

export function IPadLayout() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDms] = useState<DmChannel[]>([]);
  const [search, setSearch] = useState('');
  const [channelsCollapsed, setChannelsCollapsed] = useState(false);
  const [dmsCollapsed, setDmsCollapsed] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const router = useRouter();
  const { user } = useUser();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);

  const loadData = useCallback(async () => {
    try {
      const [chRes, dmRes] = await Promise.all([appApi.channels.list({ limit: 100 }), appApi.chatDm.list()]);
      const chs = ((chRes.data || []) as any[]).filter((c: any) => c.type !== 'dm');
      setChannels(chs);
      const dmList = (dmRes.data || []) as any[];
      setDms(dmList);
      // Auto-select first channel if none selected
      setSelectedChannelId((prev) => {
        if (prev) return prev;
        if (chs.length > 0) return chs[0].id;
        if (dmList.length > 0) return dmList[0].id;
        return null;
      });
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useChatUserEvents(loadData);

  const filteredChannels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return channels;
    return channels.filter((ch) => (ch.name || '').toLowerCase().includes(query));
  }, [channels, search]);

  const filteredDms = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return dms;
    return dms.filter((d) => (d.name || '').toLowerCase().includes(query));
  }, [dms, search]);

  const sortedDms = useMemo(() => {
    return [...filteredDms].sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [filteredDms]);

  return (
    <View style={styles.container}>
      {/* Sidebar */}
      <View style={styles.sidebar}>
        {/* Sidebar Header */}
        <View style={styles.sidebarHeader}>
          <Text style={styles.sidebarTitle}>WeldChat</Text>
          <View style={styles.sidebarHeaderActions}>
            <TouchableOpacity
              onPress={() => router.push('/settings' as any)}
              hitSlop={8}
            >
              {user?.imageUrl ? (
                <ExpoImage source={{ uri: user.imageUrl }} style={styles.profileAvatar} />
              ) : (
                <View style={[styles.profileAvatar, styles.profileAvatarFallback]}>
                  <Text style={styles.profileAvatarText}>
                    {(user?.firstName ?? '?')[0].toUpperCase()}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={styles.searchContainer}>
          <Search size={16} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search"
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
          />
        </View>

        <ScrollView style={styles.sidebarScroll} showsVerticalScrollIndicator={false}>
          {/* Channels Section */}
          <TouchableOpacity
            style={styles.sectionHeader}
            onPress={() => setChannelsCollapsed(!channelsCollapsed)}
          >
            {channelsCollapsed ? (
              <ChevronRight size={12} color={colors.textMuted} />
            ) : (
              <ChevronDown size={12} color={colors.textMuted} />
            )}
            <Text style={styles.sectionTitle}>CHANNELS</Text>
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => router.push('/new-channel' as any)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Plus size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </TouchableOpacity>

          {!channelsCollapsed &&
            filteredChannels.map((ch) => {
              const isActive = selectedChannelId === ch.id;
              return (
                <Pressable
                  key={ch.id}
                  style={[styles.sidebarItem, isActive && styles.sidebarItemActive]}
                  onPress={() => setSelectedChannelId(ch.id)}
                >
                  {ch.type === 'private' ? (
                    <Lock size={16} color={colors.textMuted} style={styles.itemIcon} />
                  ) : (
                    <Hash size={16} color={colors.textMuted} style={styles.itemIcon} />
                  )}
                  <Text
                    style={[
                      styles.itemName,
                      (ch.unreadCount ?? 0) > 0 && styles.itemNameUnread,
                      isActive && styles.itemNameActive,
                    ]}
                    numberOfLines={1}
                  >
                    {ch.name}
                  </Text>
                  {(ch.unreadCount ?? 0) > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{ch.unreadCount}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}

          {/* DMs Section */}
          <View style={styles.sectionDivider} />
          <TouchableOpacity
            style={styles.sectionHeader}
            onPress={() => setDmsCollapsed(!dmsCollapsed)}
          >
            {dmsCollapsed ? (
              <ChevronRight size={12} color={colors.textMuted} />
            ) : (
              <ChevronDown size={12} color={colors.textMuted} />
            )}
            <Text style={styles.sectionTitle}>DIRECT MESSAGES</Text>
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => router.push('/new-dm' as any)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <PenSquare size={14} color={colors.textMuted} />
            </TouchableOpacity>
          </TouchableOpacity>

          {!dmsCollapsed &&
            sortedDms.map((dm) => {
              const isActive = selectedChannelId === dm.id;
              const hasUnread = (dm.unreadCount ?? 0) > 0;
              return (
                <Pressable
                  key={dm.id}
                  style={[styles.sidebarItem, isActive && styles.sidebarItemActive]}
                  onPress={() => setSelectedChannelId(dm.id)}
                >
                  <View style={styles.dmAvatar}>
                    {dm.picture ? (
                      <Image source={{ uri: dm.picture }} style={styles.dmAvatarImage} />
                    ) : (
                      <Text style={styles.dmAvatarText}>
                        {(dm.name || '?')[0].toUpperCase()}
                      </Text>
                    )}
                  </View>
                  <View style={styles.dmInfo}>
                    <Text
                      style={[
                        styles.itemName,
                        hasUnread && styles.itemNameUnread,
                        isActive && styles.itemNameActive,
                      ]}
                      numberOfLines={1}
                    >
                      {dm.name || 'Direct Message'}
                    </Text>
                    {dm.lastMessage && (
                      <Text style={styles.dmLastMessage} numberOfLines={1}>
                        {dm.lastMessage}
                      </Text>
                    )}
                  </View>
                  {hasUnread && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{dm.unreadCount}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}

          <View style={{ height: 20 }} />
        </ScrollView>
      </View>

      {/* Main Content */}
      <View style={styles.mainContent}>
        {selectedChannelId ? (
          <ChannelView
            key={selectedChannelId}
            channelId={selectedChannelId}
            hideBackButton
          />
        ) : (
          <View style={styles.emptyMain}>
            <Text style={styles.emptyMainTitle}>Select a conversation</Text>
            <Text style={styles.emptyMainText}>
              Choose a channel or DM from the sidebar to start chatting
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: ColorScheme, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: {
      flex: 1,
      flexDirection: 'row',
      backgroundColor: c.bgPrimary,
    },
    // Sidebar
    sidebar: {
      width: SIDEBAR_WIDTH,
      backgroundColor: c.bgSecondary,
      borderRightWidth: 1,
      borderRightColor: c.bgTertiary,
    },
    sidebarHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: topInset + 12,
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    sidebarTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    sidebarHeaderActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    profileAvatar: { width: 28, height: 28, borderRadius: 8 },
    profileAvatarFallback: {
      backgroundColor: c.brand,
      justifyContent: 'center',
      alignItems: 'center',
    },
    profileAvatarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 12,
      marginBottom: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      backgroundColor: c.bgTertiary,
      borderRadius: 8,
      gap: 8,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: c.textPrimary,
      padding: 0,
    },
    sidebarScroll: { flex: 1, paddingHorizontal: 8 },
    // Section headers
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingLeft: 6,
      paddingRight: 4,
    },
    sectionTitle: {
      fontSize: 11,
      fontWeight: '700',
      color: c.textMuted,
      letterSpacing: 0.5,
      flex: 1,
      marginLeft: 8,
    },
    sectionDivider: {
      height: 1,
      backgroundColor: c.bgTertiary,
      marginHorizontal: 4,
      marginVertical: 8,
    },
    addBtn: { padding: 4 },
    // Sidebar items
    sidebarItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 7,
      paddingHorizontal: 8,
      borderRadius: 6,
      marginVertical: 1,
    },
    sidebarItemActive: {
      backgroundColor: c.channelActive,
    },
    itemIcon: { marginRight: 8 },
    itemName: {
      flex: 1,
      fontSize: 14,
      color: c.textMuted,
    },
    itemNameUnread: {
      color: c.textPrimary,
      fontWeight: '600',
    },
    itemNameActive: {
      color: c.textPrimary,
    },
    // DM-specific
    dmAvatar: {
      width: 28,
      height: 28,
      borderRadius: 10,
      backgroundColor: c.brand,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 8,
    },
    dmAvatarImage: { width: 28, height: 28, borderRadius: 10 },
    dmAvatarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
    dmInfo: { flex: 1 },
    dmLastMessage: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 1,
    },
    // Badge
    badge: {
      backgroundColor: c.badgeBg,
      borderRadius: 8,
      minWidth: 18,
      height: 18,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 5,
    },
    badgeText: { color: c.badgeText, fontSize: 11, fontWeight: '700' },
    // Main content area
    mainContent: {
      flex: 1,
      backgroundColor: c.bgPrimary,
    },
    emptyMain: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    emptyMainTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: c.textPrimary,
      marginBottom: 8,
    },
    emptyMainText: {
      fontSize: 14,
      color: c.textMuted,
      textAlign: 'center',
      maxWidth: 300,
    },
  });
