import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
} from 'react-native';
import { X, Clock, Sun, Calendar } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import CenteredModalShell from './CenteredModalShell';

interface SnoozePickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (until: string, label: string) => void;
}

function getSnoozeOptions(): { label: string; description: string; icon: 'clock' | 'sun' | 'calendar'; until: Date }[] {
  const now = new Date();

  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  const inFourHours = new Date(now.getTime() + 4 * 60 * 60 * 1000);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);

  const nextMonday = new Date(now);
  const daysUntilMonday = ((8 - nextMonday.getDay()) % 7) || 7;
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(8, 0, 0, 0);

  return [
    { label: 'In 1 hour', description: formatTime(inOneHour), icon: 'clock', until: inOneHour },
    { label: 'In 4 hours', description: formatTime(inFourHours), icon: 'clock', until: inFourHours },
    { label: 'Tomorrow morning', description: `Tomorrow, ${formatTime(tomorrow)}`, icon: 'sun', until: tomorrow },
    { label: 'Next Monday', description: `Mon, ${formatTime(nextMonday)}`, icon: 'calendar', until: nextMonday },
  ];
}

function formatTime(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

const ICON_MAP = {
  clock: Clock,
  sun: Sun,
  calendar: Calendar,
};

export default function SnoozePickerModal({ visible, onClose, onSelect }: SnoozePickerModalProps) {
  const { colors } = useTheme();
  const options = getSnoozeOptions();

  return (
    <CenteredModalShell visible={visible} onClose={onClose}>
          <View style={[styles.dialog, { backgroundColor: colors.background }]}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]}>Snooze until</Text>
              <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>

            {options.map((option) => {
              const Icon = ICON_MAP[option.icon];
              return (
                <TouchableOpacity
                  key={option.label}
                  style={[styles.option, { borderBottomColor: colors.border || '#F3F4F6' }]}
                  activeOpacity={0.6}
                  onPress={() => onSelect(option.until.toISOString(), option.label)}
                >
                  <Icon size={20} color="#F59E0B" strokeWidth={2} />
                  <View style={styles.optionText}>
                    <Text style={[styles.optionLabel, { color: colors.text }]}>{option.label}</Text>
                    <Text style={[styles.optionDescription, { color: colors.muted }]}>{option.description}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
    </CenteredModalShell>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
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
    marginBottom: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
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
