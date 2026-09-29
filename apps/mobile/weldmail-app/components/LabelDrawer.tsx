import { styles } from './LabelDrawer.styles';
import React, { useRef, useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
  Easing,
  Modal,
  TouchableWithoutFeedback,
  LayoutAnimation,
  UIManager,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  Inbox,
  Star,
  SendHorizontal,
  File,
  Trash2,
  AlertCircle,
  Archive,
  Mail,
  Clock,
  Plus,
  ChevronDown,
  ChevronUp,
  Calendar,
  Tag,
  MailX,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useMail, getAvatarColor, type MailAccount, type MailLabel } from '@/contexts/MailContext';
import { getLabelColor } from '@/utils/label-utils';
import CreateLabelDialog from '@/components/CreateLabelDialog';
import { isPersonalAccount } from '@/services/mail-tenant';
import WeldMailLogo from '@/components/WeldMailLogo';
import { BRAND, BRAND_TINT } from '@/lib/brand';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const DRAWER_WIDTH = 340;

export function getLabelIcon(slug: string, color: string, size: number = 22) {
  const icons: Record<string, React.ReactNode> = {
    INBOX: <Inbox size={size} color={color} />,
    PROMOTIONS: <Tag size={size} color={color} />,
    STARRED: <Star size={size} color={color} />,
    SENT: <SendHorizontal size={size} color={color} />,
    DRAFTS: <File size={size} color={color} />,
    DRAFT: <File size={size} color={color} />,
    TRASH: <Trash2 size={size} color={color} />,
    SPAM: <AlertCircle size={size} color={color} />,
    ARCHIVE: <Archive size={size} color={color} />,
    IMPORTANT: <AlertCircle size={size} color={color} />,
    SNOOZED: <Clock size={size} color={color} />,
    SCHEDULED: <Calendar size={size} color={color} />,
    ALL: <Mail size={size} color={color} />,
  };
  return icons[slug] || <Mail size={size} color={color} />;
}

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface DrawerPalette {
  /** Divider / border lines (mini sidebar edge, header underline, section rule). */
  border: string;
  miniAvatarBg: string;
  miniAvatarActiveBg: string;
  miniDivider: string;
  addIcon: string;
  /** Create-label "+" tint; null falls back to the theme's muted colour. */
  createIcon: string | null;
  /** "More" / "Less" toggle text + chevron. */
  toggle: string;
  sectionHeader: string;
  customSelectedBg: string;
}

const DARK_PALETTE: DrawerPalette = {
  border: '#38383A',
  miniAvatarBg: '#2C2C2E',
  miniAvatarActiveBg: '#2A1A14',
  miniDivider: '#48484A',
  addIcon: '#636366',
  createIcon: '#636366',
  toggle: '#636366',
  sectionHeader: '#636366',
  customSelectedBg: '#1A2744',
};

const LIGHT_PALETTE: DrawerPalette = {
  border: '#E5E7EB',
  miniAvatarBg: '#F1F3F4',
  miniAvatarActiveBg: '#FEF0EC',
  miniDivider: '#D1D5DB',
  addIcon: '#B0B5BC',
  createIcon: null,
  toggle: '#6B7280',
  sectionHeader: '#9CA3AF',
  customSelectedBg: '#E8F0FE',
};

/** Personal inboxes have no label-create endpoint (personal-api is read-only for labels). */
function canCreateLabel(isUnifiedInbox: boolean, account: MailAccount | null): boolean {
  return !isUnifiedInbox && !!account && !isPersonalAccount(account);
}

function getHeaderAvatarColor(isUnifiedInbox: boolean, account: MailAccount | null): string {
  if (isUnifiedInbox) return '#FEF0EC';
  return account ? getAvatarColor(account.displayName) : '#6B7280';
}

function hasCount(label: { count?: number }): boolean {
  return label.count != null && label.count > 0;
}

function SystemLabelRow({ label, isActive, colors, onSelect }: Readonly<{
  label: MailLabel;
  isActive: boolean;
  colors: ThemeColors;
  onSelect: (slug: string) => void;
}>) {
  const iconColor = isActive ? BRAND : colors.muted;
  return (
    <TouchableOpacity
      style={[styles.drawerItem, isActive && { backgroundColor: BRAND_TINT }]}
      onPress={() => onSelect(label.slug)}
    >
      {getLabelIcon(label.slug, iconColor)}
      <Text style={[
        styles.drawerItemText,
        { color: colors.text },
        isActive && { color: BRAND, fontWeight: '600' },
      ]}>
        {label.name}
      </Text>
      {hasCount(label) && (
        <Text style={[styles.drawerItemCount, { color: colors.mutedForeground }]}>
          {label.count}
        </Text>
      )}
    </TouchableOpacity>
  );
}

function CustomLabelRow({ label, isSelected, palette, onSelect }: Readonly<{
  label: MailLabel;
  isSelected: boolean;
  palette: DrawerPalette;
  onSelect: (slug: string) => void;
}>) {
  const color = getLabelColor(label.name, label.color ? { [label.name]: label.color } : undefined);
  return (
    <TouchableOpacity
      style={[styles.drawerItem, isSelected && { backgroundColor: palette.customSelectedBg }]}
      onPress={() => onSelect(label.slug)}
    >
      <View style={[styles.labelBadge, { backgroundColor: color + '26' }]}>
        <Text style={[styles.labelBadgeText, { color }]}>{label.name}</Text>
      </View>
      <View style={{ flex: 1 }} />
      {hasCount(label) && (
        <Text style={styles.drawerItemCount}>
          {label.count}
        </Text>
      )}
    </TouchableOpacity>
  );
}

function AccountAvatarButton({ account, isActive, onSelect }: Readonly<{
  account: MailAccount;
  isActive: boolean;
  onSelect: (account: MailAccount) => void;
}>) {
  return (
    <TouchableOpacity
      style={styles.miniItem}
      onPress={() => onSelect(account)}
      activeOpacity={0.7}
    >
      <View style={[styles.miniAvatar, { backgroundColor: getAvatarColor(account.displayName) }, isActive && styles.miniAvatarRing]}>
        <Text style={styles.miniAvatarText}>
          {account.displayName?.charAt(0).toUpperCase() || 'U'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

/** Left: mini account sidebar. */
function MiniSidebar({ paddingTop, colors, isDark, palette, accounts, selectedAccountId, isUnifiedInbox, onSelectUnified, onSelectAccount, onAddAccount }: Readonly<{
  paddingTop: number;
  colors: ThemeColors;
  isDark: boolean;
  palette: DrawerPalette;
  accounts: MailAccount[];
  selectedAccountId: string | undefined;
  isUnifiedInbox: boolean;
  onSelectUnified: () => void;
  onSelectAccount: (account: MailAccount) => void;
  onAddAccount: () => void;
}>) {
  return (
    <View style={[styles.miniSidebar, { paddingTop, backgroundColor: colors.card || colors.background, borderRightColor: palette.border }]}>
      <ScrollView showsVerticalScrollIndicator={false} style={styles.miniContent}>
        {/* Unified inbox */}
        <TouchableOpacity
          style={styles.miniItem}
          onPress={onSelectUnified}
          activeOpacity={0.7}
        >
          <View style={[styles.miniAvatar, { backgroundColor: palette.miniAvatarBg }, isUnifiedInbox && { backgroundColor: palette.miniAvatarActiveBg }]}>
            <WeldMailLogo size={24} color={isUnifiedInbox ? BRAND : colors.muted} />
          </View>
        </TouchableOpacity>

        {accounts.length > 0 && (
          <View style={[styles.miniDivider, { backgroundColor: palette.miniDivider }]} />
        )}

        {/* Account avatars */}
        {accounts.map((account) => (
          <AccountAvatarButton
            key={account.id}
            account={account}
            isActive={!isUnifiedInbox && selectedAccountId === account.id}
            onSelect={onSelectAccount}
          />
        ))}

        {/* Add account button */}
        <TouchableOpacity
          style={styles.miniItem}
          onPress={onAddAccount}
          activeOpacity={0.7}
        >
          <View style={[styles.miniAvatar, styles.miniAddButton, isDark && { borderColor: '#48484A' }]}>
            <Plus size={20} color={palette.addIcon} strokeWidth={2} />
          </View>
        </TouchableOpacity>
      </ScrollView>

    </View>
  );
}

/** Header — selected account info. */
function DrawerHeader({ paddingTop, palette, colors, isUnifiedInbox, selectedAccount, accountCount }: Readonly<{
  paddingTop: number;
  palette: DrawerPalette;
  colors: ThemeColors;
  isUnifiedInbox: boolean;
  selectedAccount: MailAccount | null;
  accountCount: number;
}>) {
  const headerText = isUnifiedInbox
    ? 'All Inboxes'
    : selectedAccount?.displayName || 'WeldMail';
  const showEmail = !isUnifiedInbox && !!selectedAccount?.emailAddress;

  return (
    <View style={[styles.drawerHeader, { paddingTop, borderBottomColor: palette.border }]}>
      <View style={styles.drawerHeaderRow}>
        <View style={[styles.drawerHeaderAvatar, { backgroundColor: getHeaderAvatarColor(isUnifiedInbox, selectedAccount) }]}>
          {isUnifiedInbox ? (
            <WeldMailLogo size={24} color={BRAND} />
          ) : (
            <Text style={styles.drawerHeaderAvatarText}>
              {selectedAccount?.displayName?.charAt(0).toUpperCase() || 'U'}
            </Text>
          )}
        </View>
        <View style={styles.drawerHeaderInfo}>
          <Text style={[styles.drawerTitle, { color: colors.text }]} numberOfLines={1}>{headerText}</Text>
          {showEmail && (
            <Text style={[styles.drawerSubtitle, { color: colors.muted }]} numberOfLines={1}>
              {selectedAccount?.emailAddress}
            </Text>
          )}
          {isUnifiedInbox && (
            <Text style={[styles.drawerSubtitle, { color: colors.muted }]}>
              {accountCount} {accountCount === 1 ? 'account' : 'accounts'}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

function MoreLessToggle({ label, Icon, palette, onPress }: Readonly<{
  label: string;
  Icon: typeof ChevronDown;
  palette: DrawerPalette;
  onPress: () => void;
}>) {
  return (
    <TouchableOpacity
      style={styles.drawerItem}
      onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); onPress(); }}
      activeOpacity={0.7}
    >
      <Icon size={20} color={palette.toggle} />
      <Text style={[styles.drawerItemText, { color: palette.toggle }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

interface LabelListProps {
  colors: ThemeColors;
  palette: DrawerPalette;
  mainLabels: MailLabel[];
  secondaryLabels: MailLabel[];
  customLabels: MailLabel[];
  selectedLabel: string;
  showMore: boolean;
  onSetShowMore: (show: boolean) => void;
  canCreate: boolean;
  onCreateLabel: () => void;
  onSelectLabel: (slug: string) => void;
  onOpenSubscriptions: () => void;
}

function MoreSection({ colors, palette, secondaryLabels, selectedLabel, onSelectLabel, onOpenSubscriptions, onLess }: Readonly<Pick<LabelListProps, 'colors' | 'palette' | 'secondaryLabels' | 'selectedLabel' | 'onSelectLabel' | 'onOpenSubscriptions'> & { onLess: () => void }>) {
  return (
    <>
      {/* Secondary system labels (collapsible) */}
      {secondaryLabels.map((label) => (
        <SystemLabelRow key={label.slug} label={label} isActive={selectedLabel === label.slug} colors={colors} onSelect={onSelectLabel} />
      ))}

      <TouchableOpacity
        style={styles.drawerItem}
        onPress={onOpenSubscriptions}
        activeOpacity={0.7}
        accessibilityRole="button"
      >
        <MailX size={22} color={colors.muted} />
        <Text style={[styles.drawerItemText, { color: colors.text }]}>
          Subscriptions
        </Text>
      </TouchableOpacity>

      <MoreLessToggle label="Less" Icon={ChevronUp} palette={palette} onPress={onLess} />
    </>
  );
}

function CustomLabelsSection({ colors, palette, customLabels, selectedLabel, canCreate, onCreateLabel, onSelectLabel }: Readonly<Pick<LabelListProps, 'colors' | 'palette' | 'customLabels' | 'selectedLabel' | 'canCreate' | 'onCreateLabel' | 'onSelectLabel'>>) {
  return (
    <>
      {/* Custom labels section */}
      <View style={[styles.sectionDivider, { backgroundColor: palette.border }]} />
      <View style={styles.sectionHeaderRow}>
        <Text style={[styles.sectionHeader, { color: palette.sectionHeader }]}>Labels</Text>
        {canCreate && (
          <TouchableOpacity
            onPress={onCreateLabel}
            style={styles.createLabelButton}
            activeOpacity={0.7}
          >
            <Plus size={16} color={palette.createIcon ?? colors.muted} strokeWidth={2.5} />
          </TouchableOpacity>
        )}
      </View>
      {customLabels.map((label) => (
        <CustomLabelRow
          key={label.id || label.name}
          label={label}
          isSelected={selectedLabel === label.slug}
          palette={palette}
          onSelect={onSelectLabel}
        />
      ))}
    </>
  );
}

function LabelList(props: Readonly<LabelListProps>) {
  const { colors, palette, mainLabels, secondaryLabels, selectedLabel, showMore, onSetShowMore, onSelectLabel, onOpenSubscriptions } = props;
  return (
    <ScrollView
      style={styles.labelList}
      contentContainerStyle={{ flexGrow: 1 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Main system labels */}
      {mainLabels.map((label) => (
        <SystemLabelRow key={label.slug} label={label} isActive={selectedLabel === label.slug} colors={colors} onSelect={onSelectLabel} />
      ))}

      {showMore ? (
        <MoreSection
          colors={colors}
          palette={palette}
          secondaryLabels={secondaryLabels}
          selectedLabel={selectedLabel}
          onSelectLabel={onSelectLabel}
          onOpenSubscriptions={onOpenSubscriptions}
          onLess={() => onSetShowMore(false)}
        />
      ) : (
        <MoreLessToggle label="More" Icon={ChevronDown} palette={palette} onPress={() => onSetShowMore(true)} />
      )}

      <CustomLabelsSection
        colors={colors}
        palette={palette}
        customLabels={props.customLabels}
        selectedLabel={selectedLabel}
        canCreate={props.canCreate}
        onCreateLabel={props.onCreateLabel}
        onSelectLabel={onSelectLabel}
      />
    </ScrollView>
  );
}

interface LabelDrawerProps {
  visible: boolean;
  onClose: () => void;
}

export default function LabelDrawer({ visible, onClose }: Readonly<LabelDrawerProps>) {
  const insets = useSafeAreaInsets();
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
  const {
    mainLabels, secondaryLabels, customLabels,
    selectedLabel, setSelectedLabel,
    accounts, selectedAccount, selectAccount,
    isUnifiedInbox, selectUnifiedInbox,
  } = useMail();
  const drawerAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const pendingLabelRef = useRef<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [showCreateLabel, setShowCreateLabel] = useState(false);

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(drawerAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
          easing: Easing.out(Easing.cubic),
        }),
        Animated.timing(overlayAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, drawerAnim, overlayAnim]);

  const handleClose = useCallback(() => {
    Animated.parallel([
      Animated.timing(drawerAnim, {
        toValue: -DRAWER_WIDTH,
        duration: 200,
        useNativeDriver: true,
        easing: Easing.in(Easing.cubic),
      }),
      Animated.timing(overlayAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onClose();
      if (pendingLabelRef.current) {
        setSelectedLabel(pendingLabelRef.current);
        pendingLabelRef.current = null;
      }
    });
  }, [onClose, setSelectedLabel, drawerAnim, overlayAnim]);

  const handleSelectLabel = (slug: string) => {
    pendingLabelRef.current = slug;
    handleClose();
  };

  /** Close the drawer, then navigate once its slide-out animation has finished. */
  const closeThenPush = (path: string) => {
    handleClose();
    setTimeout(() => router.push(path as any), 250);
  };

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={handleClose}>
      <TouchableWithoutFeedback onPress={handleClose}>
        <Animated.View style={[styles.overlay, { opacity: overlayAnim }]} />
      </TouchableWithoutFeedback>

      <Animated.View
        style={[
          styles.drawer,
          {
            backgroundColor: colors.background,
            transform: [{ translateX: drawerAnim }],
          },
        ]}
      >
        <View style={styles.drawerInner}>
          {/* Left: Mini account sidebar */}
          <MiniSidebar
            paddingTop={insets.top + 12}
            colors={colors}
            isDark={isDark}
            palette={palette}
            accounts={accounts}
            selectedAccountId={selectedAccount?.id}
            isUnifiedInbox={isUnifiedInbox}
            onSelectUnified={() => { selectUnifiedInbox(); handleClose(); }}
            onSelectAccount={(account) => { selectAccount(account); handleClose(); }}
            onAddAccount={() => closeThenPush('/add-account')}
          />

          {/* Right: Labels panel */}
          <View style={styles.labelPanel}>
            <DrawerHeader
              paddingTop={insets.top + 17}
              palette={palette}
              colors={colors}
              isUnifiedInbox={isUnifiedInbox}
              selectedAccount={selectedAccount}
              accountCount={accounts.length}
            />

            <LabelList
              colors={colors}
              palette={palette}
              mainLabels={mainLabels}
              secondaryLabels={secondaryLabels}
              customLabels={customLabels}
              selectedLabel={selectedLabel}
              showMore={showMore}
              onSetShowMore={setShowMore}
              canCreate={canCreateLabel(isUnifiedInbox, selectedAccount)}
              onCreateLabel={() => setShowCreateLabel(true)}
              onSelectLabel={handleSelectLabel}
              onOpenSubscriptions={() => closeThenPush('/subscriptions')}
            />

            {/* Create Label Dialog */}
            {selectedAccount && (
              <CreateLabelDialog
                visible={showCreateLabel}
                onClose={() => setShowCreateLabel(false)}
                accountId={selectedAccount.id}
              />
            )}
          </View>

        </View>
      </Animated.View>
    </Modal>
  );
}
