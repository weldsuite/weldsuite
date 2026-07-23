import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useMail } from '@/contexts/MailContext';
import { getLabelIcon } from '@/components/LabelDrawer';
import { getLabelColor } from '@/utils/label-utils';
import CreateLabelDialog from '@/components/CreateLabelDialog';

const LABEL_PANEL_WIDTH = 260;

interface LabelPanelProps {
  visible: boolean;
  onLabelSelected?: () => void;
  onClosed?: () => void;
}

export default function LabelPanel({ visible, onLabelSelected, onClosed }: LabelPanelProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const {
    mainLabels, secondaryLabels, customLabels,
    selectedLabel, setSelectedLabel,
    selectedAccount, isUnifiedInbox,
  } = useMail();
  const [showMore, setShowMore] = useState(false);
  const [showCreateLabel, setShowCreateLabel] = useState(false);
  const [mounted, setMounted] = useState(false);

  const widthAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(widthAnim, {
          toValue: LABEL_PANEL_WIDTH,
          duration: 200,
          useNativeDriver: false,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: false,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(widthAnim, {
          toValue: 0,
          duration: 180,
          useNativeDriver: false,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: false,
        }),
      ]).start(() => {
        setMounted(false);
        onClosed?.();
      });
    }
  }, [visible]);

  if (!mounted) return null;

  const headerText = isUnifiedInbox
    ? 'All Inboxes'
    : selectedAccount?.displayName || 'WeldMail';

  const handleSelect = (slug: string) => {
    setSelectedLabel(slug);
  };

  const renderSystemLabel = (label: { slug: string; name: string; count?: number }) => {
    const isActive = selectedLabel === label.slug;
    const iconColor = isActive ? '#1A73E8' : colors.muted;
    return (
      <TouchableOpacity
        key={label.slug}
        style={[styles.labelItem, isActive && { backgroundColor: 'rgba(26, 115, 232, 0.08)' }]}
        onPress={() => handleSelect(label.slug)}
        activeOpacity={0.7}
      >
        <View style={styles.labelIcon}>{getLabelIcon(label.slug, iconColor, 20)}</View>
        <Text
          style={[
            styles.labelText,
            { color: isActive ? '#1A73E8' : colors.text },
            isActive && styles.labelTextActive,
          ]}
        >
          {label.name}
        </Text>
        {label.count != null && label.count > 0 && (
          <Text style={[styles.labelCount, { color: colors.muted }]}>{label.count}</Text>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Animated.View
      style={[
        styles.container,
        {
          width: widthAnim,
          opacity: opacityAnim,
          paddingTop: insets.top,
          backgroundColor: colors.background,
          borderRightColor: colors.divider,
        },
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{headerText}</Text>
        {!isUnifiedInbox && selectedAccount?.emailAddress && (
          <Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>
            {selectedAccount.emailAddress}
          </Text>
        )}
      </View>

      {/* Labels */}
      <ScrollView style={styles.labelContent} showsVerticalScrollIndicator={false}>
        {mainLabels.map(renderSystemLabel)}

        {/* More / Less toggle */}
        <TouchableOpacity
          style={styles.labelItem}
          onPress={() => setShowMore(!showMore)}
          activeOpacity={0.7}
        >
          <View style={styles.labelIcon}>
            {showMore ? (
              <ChevronUp size={18} color={colors.muted} />
            ) : (
              <ChevronDown size={18} color={colors.muted} />
            )}
          </View>
          <Text style={[styles.labelText, { color: colors.muted }]}>
            {showMore ? 'Less' : 'More'}
          </Text>
        </TouchableOpacity>

        {showMore && secondaryLabels.map(renderSystemLabel)}

        {/* Custom labels */}
        <View style={[styles.sectionDivider, { backgroundColor: colors.divider || '#E5E7EB' }]} />
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionHeader, { color: colors.muted }]}>Labels</Text>
          {!isUnifiedInbox && selectedAccount && (
            <TouchableOpacity
              onPress={() => setShowCreateLabel(true)}
              style={styles.createLabelButton}
              activeOpacity={0.7}
            >
              <Plus size={14} color={colors.muted} strokeWidth={2.5} />
            </TouchableOpacity>
          )}
        </View>
        {customLabels.map((label) => {
          const isActive = selectedLabel === label.slug;
          const color = getLabelColor(label.name, label.color ? { [label.name]: label.color } : undefined);
          return (
            <TouchableOpacity
              key={label.id || label.name}
              style={[styles.labelItem, isActive && { backgroundColor: 'rgba(26, 115, 232, 0.08)' }]}
              onPress={() => handleSelect(label.slug)}
              activeOpacity={0.7}
            >
              <View style={[styles.customLabelBadge, { backgroundColor: color + '26' }]}>
                <Text style={[styles.customLabelText, { color }]}>{label.name}</Text>
              </View>
              {label.count != null && label.count > 0 && (
                <Text style={[styles.labelCount, { color: colors.muted }]}>{label.count}</Text>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {selectedAccount && (
        <CreateLabelDialog
          visible={showCreateLabel}
          onClose={() => setShowCreateLabel(false)}
          accountId={selectedAccount.id}
        />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRightWidth: 0.5,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  labelContent: {
    flex: 1,
    paddingHorizontal: 6,
    paddingTop: 4,
  },
  labelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 10,
    gap: 10,
  },
  labelIcon: {
    width: 24,
    alignItems: 'center',
  },
  labelText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
  labelTextActive: {
    fontWeight: '600',
  },
  labelCount: {
    fontSize: 12,
    fontWeight: '500',
  },
  sectionDivider: {
    height: 0.5,
    marginHorizontal: 6,
    marginVertical: 8,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 6,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  createLabelButton: {
    padding: 4,
    borderRadius: 6,
  },
  customLabelBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  customLabelText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
