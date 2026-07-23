import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Animated,
  PanResponder,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { Hash, Lock, ChevronRight, Search, Check, Bookmark, SquarePen, Plus } from 'lucide-react-native';
import { useOrganization, useOrganizationList, useUser } from '@clerk/expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import appApi from '@/services/app-api';
import { useChatUserEvents } from '@/hooks/useChatUserEvents';
import { getEntityTypeInfo, listEntityTypes, FallbackEntityIcon } from '@/lib/entity-channels/registry';

interface Channel {
  id: string;
  name: string;
  type: string;
  sectionId?: string | null;
  unreadCount?: number;
  // Set only for type='entity' channels linked to a business object.
  entityType?: string | null;
  entityId?: string | null;
  entityDisplayName?: string | null;
}

interface Section {
  id: string;
  name: string;
  position: number;
}

export default function HomeTab() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [search, setSearch] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [sectionMenu, setSectionMenu] = useState<{ id: string; name: string } | null>(null);
  const sheetTranslateY = useRef(new Animated.Value(800)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  const animateSheetOut = useCallback(() => {
    Animated.parallel([
      Animated.timing(sheetTranslateY, {
        toValue: 800,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) setSectionMenu(null);
    });
  }, [sheetTranslateY, backdropOpacity]);

  const openSectionMenu = useCallback((s: { id: string; name: string }) => {
    sheetTranslateY.setValue(800);
    backdropOpacity.setValue(0);
    setSectionMenu(s);
  }, [sheetTranslateY, backdropOpacity]);

  const closeSectionMenu = useCallback(() => {
    animateSheetOut();
  }, [animateSheetOut]);

  useEffect(() => {
    if (sectionMenu) {
      Animated.parallel([
        Animated.spring(sheetTranslateY, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 0,
          speed: 20,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [sectionMenu, sheetTranslateY, backdropOpacity]);

  const sheetPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        g.dy > 5 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) sheetTranslateY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 100 || g.vy > 0.5) {
          animateSheetOut();
        } else {
          Animated.spring(sheetTranslateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 4,
          }).start();
        }
      },
    })
  ).current;
  const router = useRouter();
  const { organization } = useOrganization();
  const { user } = useUser();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top), [colors, insets.top]);
  const { setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const handleSwitchWorkspace = useCallback(async (orgId: string) => {
    if (!setActive || orgId === organization?.id) {
      setShowSwitcher(false);
      return;
    }
    setSwitching(true);
    try {
      await setActive({ organization: orgId });
      setShowSwitcher(false);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
    } finally {
      setSwitching(false);
    }
  }, [setActive, organization?.id]);

  const loadData = useCallback(async () => {
    try {
      const [chRes, secRes] = await Promise.all([
        // limit 100 (the endpoint cap) so entity channels aren't paginated out
        // by the default page size of 25.
        appApi.channels.list({ limit: 100 }),
        appApi.chatSections.list(),
      ]);
      setChannels((chRes.data || []).filter((c: any) => c.type !== 'dm'));
      setSections((secRes.data || []) as any);
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  useChatUserEvents(loadData);

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  }, []);

  // Group channels: regular channels by section, entity-linked channels by
  // entityType (mirrors apps/web/platform .../use-weldchat-sidebar-items.tsx).
  const groupedSections = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (ch: Channel) =>
      !query || (ch.entityDisplayName || ch.name || '').toLowerCase().includes(query);

    // Regular channels (exclude dm + entity) grouped by section.
    const regular = channels.filter(
      (ch) => ch.type !== 'dm' && ch.type !== 'entity' && matches(ch),
    );
    const groups: Array<{ id: string; name: string; channels: Channel[] }> = sections.map((s) => ({
      id: s.id,
      name: s.name,
      channels: regular.filter((ch) => ch.sectionId === s.id),
    }));

    // Unsectioned regular channels go under a default "Channels" group.
    const unsectioned = regular.filter((ch) => !ch.sectionId);
    if (unsectioned.length > 0) {
      const hasDefaultSection = sections.some((s) => s.name === 'Channels');
      if (!hasDefaultSection) {
        groups.push({ id: '__unsectioned__', name: 'Channels', channels: unsectioned });
      }
    }

    // Entity-linked channels (tasks, companies, people, …) — one group per
    // entity type that has at least one channel.
    const entityChannels = channels.filter(
      (ch) => ch.type === 'entity' && ch.entityType && matches(ch),
    );
    for (const info of listEntityTypes()) {
      const groupChannels = entityChannels.filter((ch) => ch.entityType === info.type);
      if (groupChannels.length > 0) {
        groups.push({ id: `entity:${info.type}`, name: info.label, channels: groupChannels });
      }
    }

    return groups;
  }, [channels, sections, search]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={styles.headerTitleWrap} pointerEvents="none">
          <Text style={styles.headerTitle}>Home</Text>
        </View>

        <TouchableOpacity
          style={styles.headerAvatarBtn}
          activeOpacity={0.7}
          onPress={() => router.push('/settings' as any)}
        >
          {user?.imageUrl ? (
            <Image source={{ uri: user.imageUrl }} style={styles.headerAvatarImage} />
          ) : (
            <View style={[styles.headerAvatarImage, styles.profileAvatarFallback]}>
              <Text style={styles.profileAvatarText}>
                {(user?.firstName ?? '?')[0].toUpperCase()}
              </Text>
            </View>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.headerSquareBtn}
          activeOpacity={0.7}
          onPress={() => router.push('/new-channel' as any)}
        >
          <Plus size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchContainer}>
        <Search size={20} color={colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search"
          placeholderTextColor={colors.textSecondary}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {/* Quick actions */}
      <View style={styles.quickActions}>
        <TouchableOpacity
          style={styles.quickActionCard}
          activeOpacity={0.7}
          onPress={() => router.push('/later' as any)}
        >
          <Bookmark size={20} color={colors.textPrimary} strokeWidth={1.75} />
          <Text style={styles.quickActionTitle}>Saved</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.quickActionCard}
          activeOpacity={0.7}
          onPress={() => router.push('/drafts' as any)}
        >
          <SquarePen size={20} color={colors.textPrimary} strokeWidth={1.75} />
          <Text style={styles.quickActionTitle}>Drafts</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scrollArea} showsVerticalScrollIndicator={false}>
        {groupedSections.map((section) => {
          const isCollapsed = collapsedSections[section.id] ?? false;
          return (
            <View key={section.id}>
              <TouchableOpacity
                style={styles.sectionHeader}
                onPress={() => toggleSection(section.id)}
                onLongPress={() => openSectionMenu({ id: section.id, name: section.name })}
                delayLongPress={300}
                activeOpacity={0.7}
              >
                <Text style={styles.sectionTitle}>{section.name}</Text>
                <View style={[styles.sectionTitleChevron, !isCollapsed && styles.sectionTitleChevronOpen]}>
                  <ChevronRight size={15} color={colors.textPrimary} strokeWidth={2.5} />
                </View>
              </TouchableOpacity>

              {!isCollapsed && section.channels.length === 0 && (
                <Pressable
                  style={({ pressed }) => [styles.addChannelRow, pressed && styles.channelItemPressed]}
                  onPress={() =>
                    router.push(
                      (section.id.startsWith('entity:') || section.id === '__unsectioned__'
                        ? '/new-channel'
                        : `/new-channel?sectionId=${encodeURIComponent(section.id)}`) as any,
                    )
                  }
                >
                  <Plus size={18} color={colors.textMuted} strokeWidth={2} />
                  <Text style={styles.addChannelText}>Add channel</Text>
                </Pressable>
              )}

              {!isCollapsed &&
                section.channels.map((ch) => (
                  <Pressable
                    key={ch.id}
                    style={({ pressed }) => [styles.channelItem, pressed && styles.channelItemPressed]}
                    onPress={() => router.push(`/channel/${ch.id}` as any)}
                  >
                    {(() => {
                      const iconColor = (ch.unreadCount ?? 0) > 0 ? colors.textPrimary : colors.textSecondary;
                      if (ch.type === 'private') {
                        return <Lock size={20} color={iconColor} strokeWidth={2} style={styles.channelIcon} />;
                      }
                      if (ch.type === 'entity') {
                        const EntityIcon = (ch.entityType ? getEntityTypeInfo(ch.entityType)?.Icon : null) ?? FallbackEntityIcon;
                        return <EntityIcon size={20} color={iconColor} strokeWidth={2} style={styles.channelIcon} />;
                      }
                      return <Hash size={20} color={iconColor} strokeWidth={2} style={styles.channelIcon} />;
                    })()}
                    <Text
                      style={[
                        styles.channelName,
                        (ch.unreadCount ?? 0) > 0 && styles.channelNameUnread,
                      ]}
                      numberOfLines={1}
                    >
                      {ch.entityDisplayName || ch.name}
                    </Text>
                    {(ch.unreadCount ?? 0) > 0 && (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{ch.unreadCount}</Text>
                      </View>
                    )}
                  </Pressable>
                ))}
            </View>
          );
        })}
      </ScrollView>

      {/* Workspace Switcher Modal */}
      <Modal
        visible={showSwitcher}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSwitcher(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowSwitcher(false)}>
          <Pressable style={styles.modalContent}>
            <Text style={styles.modalTitle}>Switch Workspace</Text>
            <ScrollView style={styles.modalList}>
              {(userMemberships?.data ?? []).map((membership) => {
                const org = membership.organization;
                const isActive = org.id === organization?.id;
                return (
                  <TouchableOpacity
                    key={org.id}
                    style={[styles.modalItem, isActive && styles.modalItemActive]}
                    onPress={() => handleSwitchWorkspace(org.id)}
                    disabled={switching}
                  >
                    {org.imageUrl ? (
                      <Image source={{ uri: org.imageUrl }} style={styles.modalOrgLogo} />
                    ) : (
                      <View style={[styles.modalOrgLogo, styles.workspaceLogoFallback]}>
                        <Text style={styles.workspaceLogoText}>
                          {org.name[0].toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <Text style={styles.modalOrgName} numberOfLines={1}>
                      {org.name}
                    </Text>
                    {isActive && <Check size={18} color={colors.brand} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {switching && (
              <View style={styles.modalLoading}>
                <ActivityIndicator size="small" color={colors.brand} />
                <Text style={styles.modalLoadingText}>Switching...</Text>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Section Action Sheet */}
      <Modal
        visible={sectionMenu !== null}
        transparent
        animationType="none"
        onRequestClose={closeSectionMenu}
      >
        <Animated.View style={[styles.sheetBackdrop, { opacity: backdropOpacity }]} />
        <Pressable style={styles.sheetOverlay} onPress={closeSectionMenu}>
          <Animated.View
            style={[styles.sheet, { transform: [{ translateY: sheetTranslateY }] }]}
            {...sheetPan.panHandlers}
          >
           <Pressable>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetHeaderTitle} numberOfLines={1}>{sectionMenu?.name}</Text>
              <Text style={styles.sheetHeaderSubtitle}>
                {groupedSections.find((s) => s.id === sectionMenu?.id)?.channels.length ?? 0} channels
              </Text>
            </View>

            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                closeSectionMenu();
                router.push('/new-channel' as any);
              }}
              activeOpacity={0.6}
            >
              <Plus size={20} color={colors.textSecondary} strokeWidth={2} />
              <Text style={styles.sheetRowText}>Create channel</Text>
            </TouchableOpacity>

           </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ColorScheme, topInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: topInset + 6,
      paddingHorizontal: 16,
      paddingBottom: 8,
      backgroundColor: c.bgPrimary,
    },
    headerSquareBtn: {
      width: 40,
      height: 40,
      borderRadius: 13,
      backgroundColor: c.bgPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 2,
      elevation: 1,
    },
    headerTitleWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: topInset + 6,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerTitle: { fontSize: 19, fontWeight: '700', color: c.textPrimary },
    headerRightGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    workspaceLogoFallback: { backgroundColor: c.brand, justifyContent: 'center', alignItems: 'center' },
    workspaceLogoText: { fontSize: 14, fontWeight: '700', color: '#fff' },
    headerAvatarBtn: {
      width: 40,
      height: 40,
      borderRadius: 13,
      backgroundColor: c.bgPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      padding: 3,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 2,
      elevation: 1,
    },
    headerAvatarImage: { width: 32, height: 32, borderRadius: 10 },
    profileAvatarFallback: { backgroundColor: c.brand, justifyContent: 'center', alignItems: 'center' },
    profileAvatarText: { fontSize: 15, fontWeight: '700', color: '#fff' },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 16,
      marginTop: 8,
      marginBottom: 8,
      paddingHorizontal: 16,
      height: 40,
      backgroundColor: c.searchField,
      borderRadius: 14,
      gap: 10,
    },
    searchInput: { flex: 1, fontSize: 16, color: c.textPrimary, padding: 0, fontWeight: '500' },
    quickActions: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 10,
      gap: 8,
    },
    quickActionCard: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.bgAccent,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      gap: 6,
      backgroundColor: c.bgPrimary,
    },
    quickActionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
      marginTop: 2,
    },
    quickActionSubtitle: {
      fontSize: 12,
      color: c.textMuted,
    },
    scrollArea: { flex: 1, paddingHorizontal: 16 },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
    },
    sectionTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    sectionTitleChevron: { marginLeft: 5 },
    // Rotate the chevron down when the section is expanded.
    sectionTitleChevronOpen: { transform: [{ rotate: '90deg' }] },
    channelItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 11,
      // Inset padding (offset by a negative margin) so the pressed highlight
      // reads as a rounded gray area without shifting the row's layout.
      paddingHorizontal: 10,
      marginHorizontal: -10,
      borderRadius: 10,
    },
    channelItemPressed: {
      backgroundColor: c.bgTertiary,
    },
    channelIcon: { marginRight: 14, width: 20 },
    // Empty-category placeholder: dashed outline with a + Add channel affordance.
    addChannelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingVertical: 11,
      paddingHorizontal: 12,
      marginVertical: 4,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: c.border,
      borderRadius: 12,
    },
    addChannelText: { fontSize: 15, color: c.textMuted, fontWeight: '500' },
    channelName: { flex: 1, fontSize: 15, color: c.textPrimary, opacity: 0.7, fontWeight: '500' },
    channelNameUnread: { color: c.textPrimary, opacity: 1, fontWeight: '700' },
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
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    modalContent: { width: '100%', maxHeight: '60%', backgroundColor: c.bgSecondary, borderRadius: 12, padding: 16 },
    modalTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginBottom: 12 },
    modalList: { flexGrow: 0 },
    modalItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: 8,
      gap: 10,
    },
    modalItemActive: { backgroundColor: c.channelActive },
    modalOrgLogo: { width: 32, height: 32, borderRadius: 8 },
    modalOrgName: { flex: 1, fontSize: 15, fontWeight: '600', color: c.textPrimary },
    modalLoading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 12 },
    modalLoadingText: { fontSize: 13, color: c.textMuted },
    sheetBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sheetOverlay: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.bgPrimary,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingTop: 8,
      paddingBottom: 32,
      paddingHorizontal: 12,
    },
    sheetHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.bgAccent,
      alignSelf: 'center',
      marginBottom: 8,
    },
    sheetHeader: {
      paddingHorizontal: 8,
      paddingTop: 8,
      paddingBottom: 16,
    },
    sheetHeaderTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    sheetHeaderSubtitle: {
      fontSize: 13,
      color: c.textMuted,
      marginTop: 2,
    },
    sheetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingHorizontal: 8,
      paddingVertical: 12,
    },
    sheetRowText: {
      flex: 1,
      fontSize: 16,
      color: c.textPrimary,
      fontWeight: '500',
    },
  });
