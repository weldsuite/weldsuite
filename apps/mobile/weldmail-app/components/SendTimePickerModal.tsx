import React from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { X, Clock, Sun, Coffee, Calendar, CalendarClock, ChevronRight } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import CenteredModalShell from './CenteredModalShell';
import { buildSendTimePresets, type SendTimeIcon } from '@/utils/schedule-time';

interface SendTimePickerModalProps {
  visible: boolean;
  /** Sheet title — "Send Later" vs "Schedule Send". */
  title: string;
  onClose: () => void;
  onSelect: (date: Date) => void;
  /** Opens the full date + time picker. */
  onCustom: () => void;
}

const ICON_MAP: Record<SendTimeIcon, typeof Clock> = {
  clock: Clock,
  sun: Sun,
  coffee: Coffee,
  calendar: Calendar,
};

/**
 * Themed replacement for the ActionSheetIOS / Alert.alert pair that used to
 * present the send-time options. Same four presets plus "Pick date & time",
 * but rendered from theme tokens so it matches the app in dark mode. Design
 * follows SnoozePickerModal — the app's other "pick a later time" dialog.
 */
export default function SendTimePickerModal({
  visible,
  title,
  onClose,
  onSelect,
  onCustom,
}: SendTimePickerModalProps) {
  const { colors } = useTheme();
  // Rebuilt per open so "In 1 hour" is relative to now, not to mount time.
  const presets = React.useMemo(
    () => (visible ? buildSendTimePresets(new Date()) : []),
    [visible],
  );

  return (
    <CenteredModalShell visible={visible} onClose={onClose}>
      <View style={[styles.dialog, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityLabel="Close">
            <X size={20} color={colors.muted} />
          </TouchableOpacity>
        </View>
        <Text style={[styles.subtitle, { color: colors.muted }]}>Choose when to send this email</Text>

        {presets.map((preset) => {
          const Icon = ICON_MAP[preset.icon];
          return (
            <TouchableOpacity
              key={preset.key}
              style={[styles.option, { borderBottomColor: colors.border }]}
              activeOpacity={0.6}
              onPress={() => onSelect(preset.date)}
            >
              <Icon size={20} color={colors.info} strokeWidth={2} />
              <View style={styles.optionText}>
                <Text style={[styles.optionLabel, { color: colors.text }]}>{preset.label}</Text>
                <Text style={[styles.optionDescription, { color: colors.muted }]}>
                  {preset.description}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity style={styles.customRow} activeOpacity={0.6} onPress={onCustom}>
          <CalendarClock size={20} color={colors.info} strokeWidth={2} />
          <View style={styles.optionText}>
            <Text style={[styles.optionLabel, { color: colors.text }]}>Pick date &amp; time</Text>
            <Text style={[styles.optionDescription, { color: colors.muted }]}>
              Choose an exact moment
            </Text>
          </View>
          <ChevronRight size={18} color={colors.muted} strokeWidth={2} />
        </TouchableOpacity>
      </View>
    </CenteredModalShell>
  );
}

const styles = StyleSheet.create({
  dialog: {
    width: 320,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 13,
    marginTop: 2,
    marginBottom: 6,
  },
  closeButton: {
    padding: 4,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingTop: 14,
  },
  optionText: {
    flex: 1,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  optionDescription: {
    fontSize: 13,
    marginTop: 2,
  },
});
