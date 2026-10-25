import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Modal,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Animated,
  PanResponder,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useObserve } from 'expo-observe';
import { Image } from 'expo-image';
import Svg, { Defs, Pattern, Path, Rect } from 'react-native-svg';
import {
  Hash,
  Lock,
  ChevronDown,
  ChevronRight,
  Bookmark,
  SendHorizontal,
  Plus,
  MessageSquarePlus,
  SquarePen,
  FolderPlus,
} from 'lucide-react-native';
import { useAuth, useOrganization, useOrganizationList, useUser } from '@clerk/expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi, appApiClient } from '@/services/app-api';
import { useChatUserEvents } from '@/hooks/useChatUserEvents';
import { useChatCache } from '@/hooks/useChatCache';
import { mapDm, type DmChannel } from '@/lib/chat/dm';
import { SearchField } from '@/components/chat/SearchField';
import { ComposeMenu } from '@/components/home/ComposeMenu';
import {
  ConversationMenu,
  dmMenuTarget,
  type ConversationPatch,
  type MenuConversation,
} from '@/components/home/ConversationMenu';
import { PhoneLogIcon } from '@/components/icons/PhoneLogIcon';
import { floatingTabBarBottomInset } from '@/components/floating-tab-bar';
import { hideAppSplash } from '@/utils/splash';

interface Channel {
  id: string;
  name: string;
  type: string;
  sectionId?: string | null;
  unreadCount?: number;
  isMuted?: boolean;
  lastMessageAt?: string | null;
  /** When you last read it; null = never. Absent from an older API: then nothing reads as unread. */
  lastReadAt?: string | null;
  /** Mentions of you since you last read it. */
  unreadMentionCount?: number;
}

interface Section {
  id: string;
  name: string;
  position: number;
}

/** How many recent conversations Home shows before "See all". */
const RECENT_DM_COUNT = 5;
/** The bookmark list is fetched with this cap; at the cap the count reads "50+". */
const SAVED_CAP = 50;
/** Space between the compose button and the top of the tab bar's slot. */
const COMPOSE_BUTTON_GAP = 6;
/** Workspace menu actions are this prefix plus the organization id. */
const WORKSPACE_ACTION = 'workspace:';

type Styles = ReturnType<typeof makeStyles>;

/** A section's actions, shown in a bottom sheet on long-press. */
type HomeSheet = { id: string; name: string };

/**
 * Home, the screen the app opens on: the workspace at the top (tap to switch),
 * search, Saved and Drafts, what is unread, the channel sections and the most
 * recent direct messages.
 */
export default function HomeTab() {
  const { markInteractive } = useObserve();
  const { t, plural } = useI18n();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [dms, setDms] = useState<DmChannel[]>([]);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [draftCount, setDraftCount] = useState<number | null>(null);
  const [liveCallCount, setLiveCallCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [switching, setSwitching] = useState(false);
  const [sheet, setSheet] = useState<HomeSheet | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
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
      if (finished) setSheet(null);
    });
  }, [sheetTranslateY, backdropOpacity]);

  const openSheet = useCallback((next: HomeSheet) => {
    sheetTranslateY.setValue(800);
    backdropOpacity.setValue(0);
    setSheet(next);
  }, [sheetTranslateY, backdropOpacity]);

  const closeSheet = useCallback(() => {
    animateSheetOut();
  }, [animateSheetOut]);

  useEffect(() => {
    if (sheet) {
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
  }, [sheet, sheetTranslateY, backdropOpacity]);

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
  const { userId: authUserId } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(colors, insets.top), [colors, insets.top]);
  const cache = useChatCache();
  // Set when a network fetch lands so a late cache read can't overwrite it.
  const networkLoadedRef = useRef(false);
  const { setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const handleSwitchWorkspace = useCallback(async (orgId: string) => {
    if (!setActive || orgId === organization?.id) return;
    setSwitching(true);
    try {
      await setActive({ organization: orgId });
    } catch (err) {
      console.error('Failed to switch workspace:', err);
    } finally {
      setSwitching(false);
    }
  }, [setActive, organization?.id]);

  // Cache-first paint so Home isn't blank while the network round-trip runs.
  // Re-runs when the latched org changes so a workspace switch can't leave
  // another org's channels on screen.
  useEffect(() => {
    let cancelled = false;
    networkLoadedRef.current = false;
    void (async () => {
      const [cachedChannels, cachedSections, cachedDms] = await Promise.all([
        cache.getChannels(),
        cache.getSections(),
        cache.getDms(),
      ]);
      if (cancelled || networkLoadedRef.current) return;
      setChannels((cachedChannels as Channel[] | null) ?? []);
      setSections((cachedSections as Section[] | null) ?? []);
      setDms((cachedDms as DmChannel[] | null) ?? []);
      if (cachedChannels?.length) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [cache]);

  const loadData = useCallback(async () => {
    try {
      const [chRes, secRes, dmRes] = await Promise.all([
        // limit 100 (the endpoint cap) so channels aren't paginated out
        // by the default page size of 25.
        appApi.channels.list({ limit: 100 }),
        appApi.chatSections.list(),
        appApi.chatDm.list(),
      ]);
      // Match platform WeldChat: DMs have their own list, and entity/object
      // channels stay on their object panels — sections list people channels only.
      const nextChannels = (chRes.data || []).filter(
        (c: any) => c.type !== 'dm' && c.type !== 'entity',
      ) as Channel[];
      const nextSections = (secRes.data || []) as Section[];
      const nextDms = ((dmRes.data ?? []) as unknown[]).map((d) => mapDm(d, user?.id));
      networkLoadedRef.current = true;
      setChannels(nextChannels);
      setSections(nextSections);
      setDms(nextDms);
      void cache.setChannels(nextChannels);
      void cache.setSections(nextSections);
      void cache.setDms(nextDms);
    } catch (err) {
      // Keep any cached / previously-loaded list instead of clearing to [].
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  }, [cache, user?.id]);

  // The counts on the Calls, Saved and Drafts cards. Best effort: a failure
  // just leaves the card without a count. Waits for the signed-in user, like
  // the Saved screen: at app start Home is focused before the session is ready.
  const loadCounts = useCallback(() => {
    if (!authUserId) return;
    appApi.chatCalls
      .active()
      .then((res) => setLiveCallCount((res.data ?? []).length))
      .catch(() => {});
    appApiClient
      .get<{ data: unknown[] }>(`/chat-bookmarks?limit=${SAVED_CAP}`)
      .then((res) => setSavedCount((res.data ?? []).length))
      .catch(() => {});
    appApiClient
      .get<{ data: unknown[] }>('/chat-drafts')
      .then((res) => setDraftCount((res.data ?? []).length))
      .catch(() => {});
  }, [authUserId]);

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
      loadCounts();
    }, [loadData, loadCounts])
  );

  useChatUserEvents(loadData);

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  }, []);

  // Group regular channels by section. Entity-linked object conversations
  // are intentionally omitted — same rule as platform WeldChat's sidebar.
  const groupedSections = useMemo(() => {
    const groups: { id: string; name: string; channels: Channel[] }[] = sections.map((s) => ({
      id: s.id,
      name: s.name,
      channels: channels.filter((ch) => ch.sectionId === s.id),
    }));

    // Unsectioned regular channels go under a default "Channels" group.
    const unsectioned = channels.filter((ch) => !ch.sectionId);
    if (unsectioned.length > 0) {
      const hasDefaultSection = sections.some((s) => s.name === 'Channels');
      if (!hasDefaultSection) {
        groups.push({ id: '__unsectioned__', name: t.home.channelsGroup, channels: unsectioned });
      }
    }

    return groups;
  }, [channels, sections, t]);

  const recentDms = useMemo(() => recentDmsSorted(dms).slice(0, RECENT_DM_COUNT), [dms]);

  // Unread at a glance: conversations first (newest on top), then channels.
  const unreadDms = useMemo(
    () => recentDmsSorted(dms).filter((d) => d.hasUnread && !d.isMuted),
    [dms],
  );
  const unreadChannels = useMemo(() => channels.filter(isChannelUnread), [channels]);
  const unreadTotal = unreadDms.length + unreadChannels.length;

  // Nothing at all yet: point at the two ways to get started.
  const showEmptyState = !loading && channels.length === 0 && dms.length === 0;

  // A change made from a row's long-press menu, shown right away.
  const patchChannel = useCallback((id: string, patch: ConversationPatch) => {
    setChannels((prev) =>
      prev.map((ch) => {
        if (ch.id !== id) return ch;
        const next = { ...ch };
        if (patch.isMuted !== undefined) next.isMuted = patch.isMuted;
        if (patch.hasUnread === false) {
          next.unreadCount = 0;
          next.unreadMentionCount = 0;
          next.lastReadAt = new Date().toISOString();
        }
        return next;
      }),
    );
    if (patch.hasUnread === true) void loadData();
  }, [loadData]);
  const patchDm = useCallback((id: string, patch: ConversationPatch) => {
    if (patch.archived === false) {
      void loadData();
      return;
    }
    setDms((prev) =>
      patch.archived
        ? prev.filter((dm) => dm.id !== id)
        : prev.map((dm) => (dm.id === id ? { ...dm, ...withoutArchived(patch) } : dm)),
    );
  }, [loadData]);

  // Opens a screen from the sheet or the compose card once it is gone. On iOS
  // a modal screen pushed while a <Modal> is still up is dismissed together
  // with it, so the push waits for the Modal's onDismiss.
  const pendingHrefRef = useRef<string | null>(null);
  const goFromSheet = (href: string) => {
    pendingHrefRef.current = href;
    closeSheet();
  };
  const goFromCompose = (href: string) => {
    pendingHrefRef.current = href;
    setComposeOpen(false);
  };
  const flushPendingHref = useCallback(() => {
    const href = pendingHrefRef.current;
    pendingHrefRef.current = null;
    if (href) router.push(href as any);
  }, [router]);
  // Android has no Modal onDismiss; the sheet is gone once `sheet` is null.
  useEffect(() => {
    if (!sheet && Platform.OS !== 'ios') flushPendingHref();
  }, [sheet, flushPendingHref]);

  const workspaceName = organization?.name || t.home.workspaceFallback;
  const profileEmail = user?.primaryEmailAddress?.emailAddress ?? '';
  const profileName = user?.fullName || user?.firstName || profileEmail || '?';

  // The workspace menu: you (profile and settings), then the workspaces with
  // a check on the current one.
  const workspaceMenu: MenuAction[] = [
    {
      id: 'account',
      title: profileEmail || profileName,
      displayInline: true,
      subactions: [{ id: 'settings', title: t.home.profileAndSettings, image: 'gearshape' }],
    },
    {
      id: 'workspaces',
      title: t.home.switchWorkspace,
      displayInline: true,
      subactions: (userMemberships?.data ?? []).map(({ organization: org }) => ({
        id: `${WORKSPACE_ACTION}${org.id}`,
        title: org.name,
        state: org.id === organization?.id ? 'on' : 'off',
      })),
    },
  ];
  const handleWorkspaceMenu = (action: string) => {
    if (action === 'settings') router.push('/settings' as any);
    else if (action.startsWith(WORKSPACE_ACTION)) void handleSwitchWorkspace(action.slice(WORKSPACE_ACTION.length));
  };
  const countLabel = (count: number | null, forms: { one: string; other: string }, cap?: number) => {
    if (count === null) return null;
    if (cap && count >= cap) return plural(count, forms).replace(String(count), `${cap}+`);
    return plural(count, forms);
  };

  return (
    <View style={styles.container}>
      {/* Header: the workspace; tap for the menu with your profile and the workspaces. */}
      <View style={styles.headerRow}>
        <MenuView
          actions={workspaceMenu}
          onPressAction={({ nativeEvent }) => handleWorkspaceMenu(nativeEvent.event)}
          style={styles.workspaceMenu}
        >
          <View
            style={[styles.workspaceBtn, { maxWidth: screenWidth - 32 }]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${workspaceName}, ${t.home.switchWorkspace}`}
          >
            {organization?.imageUrl ? (
              <Image source={{ uri: organization.imageUrl }} style={styles.workspaceLogo} />
            ) : (
              <View style={[styles.workspaceLogo, styles.workspaceLogoFallback]}>
                <Text style={[styles.workspaceLogoText, styles.workspaceLogoTextSmall]}>
                  {workspaceName[0]?.toUpperCase()}
                </Text>
              </View>
            )}
            <Text style={styles.workspaceName} numberOfLines={1}>{workspaceName}</Text>
            {switching ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} accessibilityLabel={t.home.switching} />
            ) : (
              <ChevronDown size={18} color={colors.mutedForeground} strokeWidth={2.2} />
            )}
          </View>
        </MenuView>

      </View>

      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <SearchField
          placeholder={t.common.search}
          onPress={() => router.push('/search' as any)}
          style={styles.search}
        />

        {/* Calls, Saved and Drafts, with how many there are. */}
        <View style={styles.quickActions}>
          <QuickTile
            icon={<PhoneLogIcon size={16} color={colors.text} strokeWidth={2} />}
            title={t.tabs.calls}
            subtitle={countLabel(liveCallCount, t.home.liveCount)}
            onPress={() => router.navigate('/calls' as any)}
            styles={styles}
          />
          <QuickTile
            icon={<Bookmark size={16} color={colors.text} strokeWidth={2} />}
            title={t.home.saved}
            subtitle={countLabel(savedCount, t.home.itemCount, SAVED_CAP)}
            onPress={() => router.push('/later' as any)}
            styles={styles}
          />
          <QuickTile
            icon={<SendHorizontal size={16} color={colors.text} strokeWidth={2} />}
            title={t.home.drafts}
            subtitle={countLabel(draftCount, t.home.itemCount)}
            onPress={() => router.push('/drafts' as any)}
            styles={styles}
          />
        </View>

        {showEmptyState && (
          <View style={styles.emptyState}>
            <EmptyIllustration colors={colors} styles={styles} />
            <Text style={styles.emptyTitle}>{t.home.emptyTitle}</Text>
            <Text style={styles.emptyText}>{t.home.emptyHint}</Text>
            <TouchableOpacity
              style={styles.emptyPrimaryBtn}
              activeOpacity={0.85}
              onPress={() => router.push('/new-channel' as any)}
              accessibilityRole="button"
            >
              <Plus size={18} color={colors.background} strokeWidth={2.4} />
              <Text style={styles.emptyPrimaryText}>{t.home.emptyCreateChannel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.emptySecondaryBtn}
              activeOpacity={0.7}
              onPress={() => router.push('/new-dm' as any)}
              accessibilityRole="button"
            >
              <MessageSquarePlus size={18} color={colors.text} strokeWidth={2} />
              <Text style={styles.emptySecondaryText}>{t.home.emptyStartDm}</Text>
            </TouchableOpacity>
          </View>
        )}

        {!showEmptyState && unreadTotal > 0 && (
          <View style={styles.block}>
            <SectionHeader title={t.home.unreads} count={unreadTotal} styles={styles} colors={colors} />
            {unreadDms.map((dm) => (
              <ConversationMenu key={`u-${dm.id}`} conversation={dmMenuTarget(dm)} onChange={patchDm}>
                <DmRow dm={dm} styles={styles} />
              </ConversationMenu>
            ))}
            {unreadChannels.map((ch) => (
              <ConversationMenu key={`u-${ch.id}`} conversation={channelMenuTarget(ch)} onChange={patchChannel}>
                <ChannelRow channel={ch} styles={styles} colors={colors} />
              </ConversationMenu>
            ))}
          </View>
        )}

        {!showEmptyState && groupedSections.map((section) => {
          const isCollapsed = collapsedSections[section.id] ?? false;
          return (
            <View key={section.id} style={styles.block}>
              <SectionHeader
                title={section.name}
                collapsed={isCollapsed}
                onPress={() => toggleSection(section.id)}
                onLongPress={() => openSheet({ id: section.id, name: section.name })}
                styles={styles}
                colors={colors}
              />
              {!isCollapsed &&
                section.channels.map((ch) => (
                  <ConversationMenu key={ch.id} conversation={channelMenuTarget(ch)} onChange={patchChannel}>
                    <ChannelRow channel={ch} styles={styles} colors={colors} />
                  </ConversationMenu>
                ))}
            </View>
          );
        })}

        {!showEmptyState && recentDms.length > 0 && (
          <View style={styles.block}>
            <SectionHeader
              title={t.tabs.directMessages}
              action={{ label: t.home.seeAll, onPress: () => router.navigate('/dms' as any) }}
              styles={styles}
              colors={colors}
            />
            {recentDms.map((dm) => (
              <ConversationMenu key={dm.id} conversation={dmMenuTarget(dm)} onChange={patchDm}>
                <DmRow dm={dm} styles={styles} />
              </ConversationMenu>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Compose, like Slack's: the button and the card it opens. */}
      <ComposeMenu
        open={composeOpen}
        onOpen={() => setComposeOpen(true)}
        bottom={floatingTabBarBottomInset(insets.bottom) + COMPOSE_BUTTON_GAP}
        buttonBottom={COMPOSE_BUTTON_GAP}
        buttonLabel={t.home.newItem}
        items={[
          {
            key: 'channel',
            icon: <Hash size={20} color={colors.text} strokeWidth={1.9} />,
            title: t.home.composeChannel,
            hint: t.home.composeChannelHint,
            onPress: () => goFromCompose('/new-channel'),
          },
          {
            key: 'category',
            icon: <FolderPlus size={20} color={colors.text} strokeWidth={1.9} />,
            title: t.home.composeCategory,
            hint: t.home.composeCategoryHint,
            onPress: () => goFromCompose('/new-category'),
          },
        ]}
        primary={{
          icon: <SquarePen size={20} color={colors.background} strokeWidth={2.1} />,
          label: t.home.composeMessage,
          onPress: () => goFromCompose('/new-message'),
        }}
        onRequestClose={() => setComposeOpen(false)}
        onClosed={flushPendingHref}
      />

      {/* A section's actions (long-press its header). */}
      <Modal
        visible={sheet !== null}
        transparent
        animationType="none"
        onRequestClose={closeSheet}
        onDismiss={flushPendingHref}
      >
        <Animated.View style={[styles.sheetBackdrop, { opacity: backdropOpacity }]} />
        <Pressable style={styles.sheetOverlay} onPress={closeSheet}>
          <Animated.View
            style={[styles.sheet, { transform: [{ translateY: sheetTranslateY }] }]}
            {...sheetPan.panHandlers}
          >
           <Pressable>
            <View style={styles.sheetHandle} />
            {sheet && (
              <>
                <View style={styles.sheetHeader}>
                  <Text style={styles.sheetHeaderTitle} numberOfLines={1}>{sheet.name}</Text>
                  <Text style={styles.sheetHeaderSubtitle}>
                    {plural(groupedSections.find((s) => s.id === sheet.id)?.channels.length ?? 0, t.home.channelCount)}
                  </Text>
                </View>
                <SheetOption
                  icon={<Plus size={20} color={colors.text} strokeWidth={2} />}
                  title={t.home.createChannel}
                  hint={t.home.createChannelHint}
                  onPress={() =>
                    goFromSheet(
                      sheet.id === '__unsectioned__'
                        ? '/new-channel'
                        : `/new-channel?sectionId=${encodeURIComponent(sheet.id)}`,
                    )
                  }
                  styles={styles}
                />
              </>
            )}
           </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    </View>
  );
}

function mentionCount(ch: Channel): number {
  return ch.unreadMentionCount || ch.unreadCount || 0;
}

/** A message since you last read it, like the web sidebar and the DM list. */
function isChannelUnread(ch: Channel): boolean {
  if (mentionCount(ch) > 0) return true;
  if (ch.lastReadAt === undefined || !ch.lastMessageAt) return false;
  return ch.lastReadAt === null || new Date(ch.lastMessageAt) > new Date(ch.lastReadAt);
}

function channelMenuTarget(ch: Channel): MenuConversation {
  return { kind: 'channel', id: ch.id, name: ch.name, type: ch.type, isMuted: ch.isMuted, hasUnread: isChannelUnread(ch) };
}

function withoutArchived({ archived: _archived, ...rest }: ConversationPatch): Partial<DmChannel> {
  return rest;
}

function recentDmsSorted(dms: DmChannel[]): DmChannel[] {
  return [...dms].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
}

/** A row in a Home bottom sheet: an icon tile, a title and a one-line hint. */
function SheetOption({
  icon,
  title,
  hint,
  onPress,
  styles,
}: Readonly<{ icon: React.ReactNode; title: string; hint: string; onPress: () => void; styles: Styles }>) {
  return (
    <Pressable
      style={({ pressed }) => [styles.sheetOption, pressed && styles.sheetOptionPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={hint}
    >
      <View style={styles.sheetOptionIcon}>{icon}</View>
      <View style={styles.sheetOptionText}>
        <Text style={styles.sheetOptionTitle}>{title}</Text>
        <Text style={styles.sheetOptionHint} numberOfLines={1}>{hint}</Text>
      </View>
    </Pressable>
  );
}

function QuickTile({
  icon,
  title,
  subtitle,
  onPress,
  styles,
}: Readonly<{ icon: React.ReactNode; title: string; subtitle: string | null; onPress: () => void; styles: Styles }>) {
  return (
    <Pressable
      style={({ pressed }) => [styles.quickTile, pressed && styles.quickTilePressed]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <View style={styles.quickTileHead}>
        <View style={styles.quickTileIcon}>{icon}</View>
        {/* Shrinks a little on a narrow phone rather than cutting the word off. */}
        <Text style={styles.quickTileTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
          {title}
        </Text>
      </View>
      {/* A blank line while the count loads, so the card keeps its height. */}
      <Text style={styles.quickTileSubtitle} numberOfLines={1}>{subtitle ?? ' '}</Text>
    </Pressable>
  );
}

/** A list heading: collapsible (chevron), with a count, or with a link on the right. */
function SectionHeader({
  title,
  count,
  collapsed,
  onPress,
  onLongPress,
  action,
  styles,
  colors,
}: Readonly<{
  title: string;
  count?: number;
  collapsed?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  action?: { label: string; onPress: () => void };
  styles: Styles;
  colors: ThemeColors;
}>) {
  return (
    <View style={styles.sectionHeader}>
      <Pressable
        style={styles.sectionTitleBtn}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={300}
        disabled={!onPress && !onLongPress}
        accessibilityRole={onPress ? 'button' : 'header'}
        accessibilityState={onPress ? { expanded: !collapsed } : undefined}
      >
        <Text style={styles.sectionTitle} numberOfLines={1}>{title}</Text>
        {count !== undefined && (
          <View style={styles.countChip}>
            <Text style={styles.countChipText}>{count}</Text>
          </View>
        )}
        {onPress && (
          <View style={collapsed && styles.sectionChevronCollapsed}>
            <ChevronDown size={15} color={colors.mutedForeground} strokeWidth={2.4} />
          </View>
        )}
      </Pressable>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={8} style={styles.sectionAction} accessibilityRole="link">
          <Text style={styles.sectionActionText}>{action.label}</Text>
          <ChevronRight size={14} color={colors.mutedForeground} strokeWidth={2.2} />
        </Pressable>
      )}
    </View>
  );
}

function ChannelRow({
  channel,
  onPress,
  onPressIn,
  styles,
  colors,
}: Readonly<{ channel: Channel; onPress?: () => void; onPressIn?: () => void; styles: Styles; colors: ThemeColors }>) {
  const unread = isChannelUnread(channel);
  const Icon = channel.type === 'private' ? Lock : Hash;
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress} onPressIn={onPressIn}>
      {unread && <View style={styles.unreadPill} />}
      <View style={styles.rowIcon}>
        <Icon size={18} color={unread ? colors.text : colors.mutedForeground} strokeWidth={2} />
      </View>
      <Text style={[styles.rowName, unread && styles.rowNameUnread]} numberOfLines={1}>
        {channel.name}
      </Text>
      {mentionCount(channel) > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{mentionCount(channel)}</Text>
        </View>
      )}
    </Pressable>
  );
}

function DmRow({
  dm,
  onPress,
  onPressIn,
  styles,
}: Readonly<{ dm: DmChannel; onPress?: () => void; onPressIn?: () => void; styles: Styles }>) {
  const unread = !!dm.hasUnread && !dm.isMuted;
  const members = dm.otherMembers ?? [];
  let avatar: React.ReactNode;
  if (dm.isGroup && members.length > 1) {
    avatar = (
      <View style={styles.rowTilePlain}>
        {members.slice(0, 2).map((m, i) => (
          <View key={m.userId} style={[styles.groupAvatar, i === 0 ? styles.groupAvatarA : styles.groupAvatarB]}>
            {m.picture ? (
              <Image source={{ uri: m.picture }} style={StyleSheet.absoluteFill} />
            ) : (
              <Text style={styles.groupAvatarText}>{(m.name || m.email || '?')[0]?.toUpperCase()}</Text>
            )}
          </View>
        ))}
      </View>
    );
  } else if (dm.picture) {
    avatar = <Image source={{ uri: dm.picture }} style={styles.rowAvatar} />;
  } else {
    avatar = (
      <View style={[styles.rowAvatar, styles.rowAvatarFallback]}>
        <Text style={styles.rowAvatarText}>{(dm.name || '?')[0]?.toUpperCase()}</Text>
      </View>
    );
  }
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress} onPressIn={onPressIn}>
      {avatar}
      <Text style={[styles.rowName, unread && styles.rowNameUnread]} numberOfLines={1}>
        {dm.name}
      </Text>
      {unread && <View style={styles.unreadDot} />}
    </Pressable>
  );
}

/** The dashed-grid speech bubble the other empty lists use. */
function EmptyIllustration({ colors, styles }: Readonly<{ colors: ThemeColors; styles: Styles }>) {
  return (
    <View style={styles.illustration}>
      <Svg width={240} height={170} style={StyleSheet.absoluteFill}>
        <Defs>
          <Pattern id="grid" width={28} height={28} patternUnits="userSpaceOnUse">
            <Path
              d="M 28 0 L 0 0 0 28"
              fill="none"
              stroke={colors.secondary}
              strokeWidth={0.5}
              strokeDasharray="3 3"
            />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#grid)" />
      </Svg>
      <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
        <Path
          d="M20 32a10 10 0 0 1 10-10h60a10 10 0 0 1 10 10v40a10 10 0 0 1-10 10H52l-16 14V82H30a10 10 0 0 1-10-10V32z"
          fill={colors.cardBackground}
          stroke={colors.secondary}
          strokeWidth={1}
        />
        <Rect x="38" y="46" width="44" height="4" rx="2" fill={colors.secondary} />
        <Rect x="38" y="56" width="30" height="4" rx="2" fill={colors.secondary} />
        <Rect x="38" y="66" width="36" height="4" rx="2" fill={colors.secondary} />
      </Svg>
    </View>
  );
}

const makeStyles = (c: ThemeColors, topInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      // The height the old "+" button gave it, so the page doesn't shift up.
      minHeight: topInset + 6 + 40 + 8,
      paddingTop: topInset + 6,
      paddingHorizontal: 16,
      paddingBottom: 8,
      backgroundColor: c.background,
    },
    // The menu's trigger sizes to its content; the name truncates at maxWidth.
    workspaceMenu: { flexShrink: 1 },
    workspaceBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
    workspaceLogo: { width: 26, height: 26, borderRadius: 9 },
    workspaceLogoFallback: { backgroundColor: BRAND, justifyContent: 'center', alignItems: 'center' },
    workspaceLogoText: { fontSize: 15, fontWeight: '700', color: '#fff' },
    workspaceLogoTextSmall: { fontSize: 12 },
    workspaceName: { flexShrink: 1, fontSize: 18, fontWeight: '700', letterSpacing: -0.3, color: c.text },

    scrollArea: { flex: 1 },
    // Room at the bottom for the floating tab bar.
    scrollContent: { paddingHorizontal: 16, paddingBottom: 120 },
    search: { marginTop: 8 },

    // Three equal cards spanning the same width as the search bar.
    quickActions: { flexDirection: 'row', gap: 6, paddingTop: 14, paddingBottom: 6 },
    quickTile: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 11,
      paddingHorizontal: 8,
      borderRadius: 12,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    quickTilePressed: { backgroundColor: c.secondary },
    // The icon sits before the title; the count starts under the icon. Sized so
    // "Gesprekken" fits at 15pt on a 402pt-wide phone.
    quickTileHead: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    quickTileIcon: { width: 16, height: 20, alignItems: 'center', justifyContent: 'center', opacity: 0.74 },
    quickTileTitle: { flexShrink: 1, fontSize: 15, lineHeight: 20, color: c.text, opacity: 0.77 },
    quickTileSubtitle: { marginTop: 2, fontSize: 15, lineHeight: 20, color: c.text, opacity: 0.69 },

    block: { paddingTop: 14 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
    sectionTitleBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.mutedForeground,
    },
    sectionChevronCollapsed: { transform: [{ rotate: '-90deg' }] },
    countChip: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      borderRadius: 5,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countChipText: { fontSize: 10, fontWeight: '600', color: c.mutedForeground, fontVariant: ['tabular-nums'] },
    sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    sectionActionText: { fontSize: 13, fontWeight: '500', color: c.mutedForeground },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 46,
      paddingVertical: 7,
      // Inset padding (offset by a negative margin) so the pressed highlight
      // reads as a rounded gray area without shifting the row's layout.
      paddingHorizontal: 10,
      marginHorizontal: -10,
      borderRadius: 12,
    },
    rowPressed: { backgroundColor: c.secondary },
    rowIcon: { width: 20, alignItems: 'center', justifyContent: 'center' },
    rowTilePlain: { width: 26, height: 26 },
    rowAvatar: { width: 26, height: 26, borderRadius: 9 },
    rowAvatarFallback: { backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' },
    rowAvatarText: { fontSize: 12, fontWeight: '600', color: '#fff' },
    groupAvatar: {
      position: 'absolute',
      width: 18,
      height: 18,
      borderRadius: 6,
      backgroundColor: BRAND,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: c.background,
      overflow: 'hidden',
    },
    groupAvatarA: { top: 0, left: 0, zIndex: 2 },
    groupAvatarB: { bottom: 0, right: 0 },
    groupAvatarText: { fontSize: 9, fontWeight: '600', color: '#fff' },
    // Like Discord: read is gray, unread is bold in the text color.
    rowName: { flex: 1, fontSize: 16, fontWeight: '500', color: c.mutedForeground },
    rowNameUnread: { fontWeight: '700', color: c.text },
    // Discord's unread pill, half off the screen's left edge.
    unreadPill: {
      position: 'absolute',
      left: -10,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.text,
    },
    badge: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 7,
      backgroundColor: BRAND,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: { fontSize: 12, fontWeight: '700', color: '#fff' },
    unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: BRAND },

    emptyState: { alignItems: 'center', paddingHorizontal: 8, paddingTop: 24, paddingBottom: 24 },
    illustration: { width: 240, height: 170, marginBottom: 12, justifyContent: 'center', alignItems: 'center' },
    emptyTitle: { fontSize: 16, fontWeight: '600', color: c.text, marginBottom: 6 },
    emptyText: {
      fontSize: 14,
      color: c.muted,
      textAlign: 'center',
      lineHeight: 20,
      maxWidth: 280,
      marginBottom: 24,
    },
    emptyPrimaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      alignSelf: 'stretch',
      height: 46,
      borderRadius: 14,
      backgroundColor: c.text,
    },
    emptyPrimaryText: { fontSize: 15, fontWeight: '600', color: c.background },
    emptySecondaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      alignSelf: 'stretch',
      height: 46,
      borderRadius: 14,
      marginTop: 10,
      borderWidth: 1,
      borderColor: c.secondary,
    },
    emptySecondaryText: { fontSize: 15, fontWeight: '600', color: c.text },

    sheetBackdrop: {
      ...StyleSheet.absoluteFill,
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sheetOverlay: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.background,
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
      backgroundColor: c.secondary,
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
      color: c.text,
    },
    sheetHeaderSubtitle: {
      fontSize: 13,
      color: c.muted,
      marginTop: 2,
    },
    sheetOption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingHorizontal: 8,
      paddingVertical: 9,
      borderRadius: 16,
      borderCurve: 'continuous',
    },
    sheetOptionPressed: { backgroundColor: c.secondary },
    sheetOptionIcon: {
      width: 44,
      height: 44,
      borderRadius: 14,
      borderCurve: 'continuous',
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetOptionText: { flex: 1, minWidth: 0 },
    sheetOptionTitle: { fontSize: 16, fontWeight: '600', color: c.text },
    sheetOptionHint: { fontSize: 13, color: c.mutedForeground, marginTop: 2 },
  });
