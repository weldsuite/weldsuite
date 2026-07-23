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

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
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
  Layers,
  Plus,
  ChevronDown,
  ChevronUp,
  Calendar,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useMail, getAvatarColor } from '@/contexts/MailContext';
import { getLabelColor } from '@/utils/label-utils';
import CreateLabelDialog from '@/components/CreateLabelDialog';
import WeldMailLogo from '@/components/WeldMailLogo';

const DRAWER_WIDTH = 340;
const MINI_WIDTH = 68;

export function getLabelIcon(slug: string, color: string, size: number = 22) {
  const icons: Record<string, React.ReactNode> = {
    INBOX: <Inbox size={size} color={color} />,
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

interface LabelDrawerProps {
  visible: boolean;
  onClose: () => void;
}

export default function LabelDrawer({ visible, onClose }: LabelDrawerProps) {
  const insets = useSafeAreaInsets();
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
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
  }, [visible]);

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
  }, [onClose, setSelectedLabel]);

  const handleSelectLabel = (slug: string) => {
    pendingLabelRef.current = slug;
    handleClose();
  };

  if (!visible) return null;

  const headerText = isUnifiedInbox
    ? 'All Inboxes'
    : selectedAccount?.displayName || 'WeldMail';

  const renderSystemLabel = (label: { slug: string; name: string; count?: number }) => {
    const isActive = selectedLabel === label.slug;
    const iconColor = isActive ? '#1A73E8' : (isDark ? '#8E8E93' : '#5F6368');
    return (
      <TouchableOpacity
        key={label.slug}
        style={[styles.drawerItem, isActive && { backgroundColor: isDark ? '#1A2744' : '#E8F0FE' }]}
        onPress={() => handleSelectLabel(label.slug)}
      >
        {getLabelIcon(label.slug, iconColor)}
        <Text style={[
          styles.drawerItemText,
          { color: isDark ? '#E8EAED' : '#202124' },
          isActive && { color: '#1A73E8', fontWeight: '600' },
        ]}>
          {label.name}
        </Text>
        {label.count != null && label.count > 0 && (
          <Text style={styles.drawerItemCount}>
            {label.count}
          </Text>
        )}
      </TouchableOpacity>
    );
  };

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
          <View style={[styles.miniSidebar, { paddingTop: insets.top + 12, backgroundColor: colors.card || colors.background, borderRightColor: isDark ? '#38383A' : '#E5E7EB' }]}>
            <ScrollView showsVerticalScrollIndicator={false} style={styles.miniContent}>
              {/* Unified inbox */}
              <TouchableOpacity
                style={styles.miniItem}
                onPress={() => { selectUnifiedInbox(); handleClose(); }}
                activeOpacity={0.7}
              >
                <View style={[styles.miniAvatar, { backgroundColor: isDark ? '#2C2C2E' : '#F1F3F4' }, isUnifiedInbox && { backgroundColor: isDark ? '#2A1A14' : '#FEF0EC' }]}>
                  <WeldMailLogo size={24} color={isUnifiedInbox ? '#f6663e' : '#9CA3AF'} />
                </View>
              </TouchableOpacity>

              {accounts.length > 0 && (
                <View style={[styles.miniDivider, { backgroundColor: isDark ? '#48484A' : '#D1D5DB' }]} />
              )}

              {/* Account avatars */}
              {accounts.map((account) => {
                const isActive = !isUnifiedInbox && selectedAccount?.id === account.id;
                const avatarColor = getAvatarColor(account.displayName);
                return (
                  <TouchableOpacity
                    key={account.id}
                    style={styles.miniItem}
                    onPress={() => { selectAccount(account); handleClose(); }}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.miniAvatar, { backgroundColor: avatarColor }, isActive && styles.miniAvatarRing]}>
                      <Text style={styles.miniAvatarText}>
                        {account.displayName?.charAt(0).toUpperCase() || 'U'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}

              {/* Add account button */}
              <TouchableOpacity
                style={styles.miniItem}
                onPress={() => { handleClose(); setTimeout(() => router.push('/add-account' as any), 250); }}
                activeOpacity={0.7}
              >
                <View style={[styles.miniAvatar, styles.miniAddButton, isDark && { borderColor: '#48484A' }]}>
                  <Plus size={20} color={isDark ? '#636366' : '#B0B5BC'} strokeWidth={2} />
                </View>
              </TouchableOpacity>
            </ScrollView>

          </View>

          {/* Right: Labels panel */}
          <View style={styles.labelPanel}>
            {/* Header — selected account info */}
            <View style={[styles.drawerHeader, { paddingTop: insets.top + 17, borderBottomColor: isDark ? '#38383A' : '#E5E7EB' }]}>
              <View style={styles.drawerHeaderRow}>
                <View style={[styles.drawerHeaderAvatar, { backgroundColor: isUnifiedInbox ? '#FEF0EC' : selectedAccount ? getAvatarColor(selectedAccount.displayName) : '#6B7280' }]}>
                  {isUnifiedInbox ? (
                    <WeldMailLogo size={24} color="#f6663e" />
                  ) : (
                    <Text style={styles.drawerHeaderAvatarText}>
                      {selectedAccount?.displayName?.charAt(0).toUpperCase() || 'U'}
                    </Text>
                  )}
                </View>
                <View style={styles.drawerHeaderInfo}>
                  <Text style={[styles.drawerTitle, { color: colors.text }]} numberOfLines={1}>{headerText}</Text>
                  {!isUnifiedInbox && selectedAccount?.emailAddress && (
                    <Text style={[styles.drawerSubtitle, { color: colors.muted }]} numberOfLines={1}>
                      {selectedAccount.emailAddress}
                    </Text>
                  )}
                  {isUnifiedInbox && (
                    <Text style={[styles.drawerSubtitle, { color: colors.muted }]}>
                      {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
                    </Text>
                  )}
                </View>
              </View>
            </View>

            <ScrollView
              style={styles.labelList}
              contentContainerStyle={{ flexGrow: 1 }}
              showsVerticalScrollIndicator={false}
            >
              {/* Main system labels */}
              {mainLabels.map(renderSystemLabel)}

              {!showMore && (
                <TouchableOpacity
                  style={styles.drawerItem}
                  onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowMore(true); }}
                  activeOpacity={0.7}
                >
                  <ChevronDown size={20} color={isDark ? '#636366' : '#6B7280'} />
                  <Text style={[styles.drawerItemText, { color: isDark ? '#636366' : '#6B7280' }]}>
                    More
                  </Text>
                </TouchableOpacity>
              )}

              {/* Secondary system labels (collapsible) */}
              {showMore && secondaryLabels.map(renderSystemLabel)}

              {showMore && (
                <TouchableOpacity
                  style={styles.drawerItem}
                  onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowMore(false); }}
                  activeOpacity={0.7}
                >
                  <ChevronUp size={20} color={isDark ? '#636366' : '#6B7280'} />
                  <Text style={[styles.drawerItemText, { color: isDark ? '#636366' : '#6B7280' }]}>
                    Less
                  </Text>
                </TouchableOpacity>
              )}

              {/* Custom labels section */}
              <View style={[styles.sectionDivider, { backgroundColor: isDark ? '#38383A' : '#E5E7EB' }]} />
              <View style={styles.sectionHeaderRow}>
                <Text style={[styles.sectionHeader, { color: isDark ? '#636366' : '#9CA3AF' }]}>Labels</Text>
                {!isUnifiedInbox && selectedAccount && (
                  <TouchableOpacity
                    onPress={() => setShowCreateLabel(true)}
                    style={styles.createLabelButton}
                    activeOpacity={0.7}
                  >
                    <Plus size={16} color={isDark ? '#636366' : colors.muted} strokeWidth={2.5} />
                  </TouchableOpacity>
                )}
              </View>
              {customLabels.map((label) => {
                const isSelected = selectedLabel === label.slug;
                const color = getLabelColor(label.name, label.color ? { [label.name]: label.color } : undefined);
                return (
                  <TouchableOpacity
                    key={label.id || label.name}
                    style={[styles.drawerItem, isSelected && { backgroundColor: isDark ? '#1A2744' : '#E8F0FE' }]}
                    onPress={() => handleSelectLabel(label.slug)}
                  >
                    <View style={[styles.labelBadge, { backgroundColor: color + '26' }]}>
                      <Text style={[styles.labelBadgeText, { color }]}>{label.name}</Text>
                    </View>
                    <View style={{ flex: 1 }} />
                    {label.count != null && label.count > 0 && (
                      <Text style={styles.drawerItemCount}>
                        {label.count}
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

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


