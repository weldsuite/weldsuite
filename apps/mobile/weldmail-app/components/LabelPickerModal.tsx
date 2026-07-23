import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import MaterialSpinner from './MaterialSpinner';
import CenteredModalShell from './CenteredModalShell';
import { X, Check, Tag } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useMail } from '@/contexts/MailContext';
import appApi from '@/services/app-api';

interface LabelPickerModalProps {
  visible: boolean;
  onClose: () => void;
  messageId: string;
  currentLabels: string[];
  onLabelsChanged: (labels: string[]) => void;
}

export default function LabelPickerModal({ visible, onClose, messageId, currentLabels, onLabelsChanged }: LabelPickerModalProps) {
  const { colors } = useTheme();
  const { customLabels } = useMail();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setSelected(new Set(currentLabels));
    }
  }, [visible, currentLabels]);

  const toggleLabel = (labelName: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(labelName)) {
        next.delete(labelName);
      } else {
        next.add(labelName);
      }
      return next;
    });
  };

  const handleSave = async () => {
    const currentSet = new Set(currentLabels);
    const addLabels = [...selected].filter(l => !currentSet.has(l));
    const removeLabels = [...currentSet].filter(l => !selected.has(l) && !isSystemLabel(l));

    if (addLabels.length === 0 && removeLabels.length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      let finalLabels: string[] = [...selected];
      if (addLabels.length > 0) {
        const res = await appApi.mailMessages.addLabels(messageId, { labels: addLabels });
        finalLabels = res.data.labels;
      }
      if (removeLabels.length > 0) {
        const res = await appApi.mailMessages.removeLabels(messageId, { labels: removeLabels });
        finalLabels = res.data.labels;
      }
      onLabelsChanged(finalLabels);
      onClose();
    } catch (err) {
      console.error('Failed to update labels:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <CenteredModalShell visible={visible} onClose={onClose}>
          <View style={[styles.dialog, { backgroundColor: colors.background }]}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]}>Labels</Text>
              <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
              {customLabels.length === 0 ? (
                <View style={styles.emptyState}>
                  <Tag size={24} color={colors.muted} strokeWidth={1.5} />
                  <Text style={[styles.emptyText, { color: colors.muted }]}>No custom labels yet</Text>
                </View>
              ) : (
                customLabels.map((label) => {
                  const isChecked = selected.has(label.name);
                  const labelColor = label.color || '#6B7280';
                  return (
                    <TouchableOpacity
                      key={label.slug || label.name}
                      style={[styles.labelRow, { borderBottomColor: colors.border || '#F3F4F6' }]}
                      activeOpacity={0.6}
                      onPress={() => toggleLabel(label.name)}
                    >
                      <View style={[styles.labelDot, { backgroundColor: labelColor }]} />
                      <Text style={[styles.labelName, { color: colors.text }]}>{label.name}</Text>
                      {isChecked && <Check size={18} color="#3B82F6" strokeWidth={2.5} />}
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>

            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.cancelButton, { borderColor: colors.border || '#E5E7EB' }]}
                onPress={onClose}
              >
                <Text style={[styles.cancelText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveButton}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <MaterialSpinner size={18} strokeWidth={2.4} color="#FFFFFF" spinning />
                ) : (
                  <Text style={styles.saveText}>Apply</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
    </CenteredModalShell>
  );
}

const SYSTEM_LABELS_SET = new Set([
  'INBOX', 'SENT', 'DRAFTS', 'TRASH', 'SPAM', 'STARRED',
  'IMPORTANT', 'ARCHIVE', 'SNOOZED', 'SCHEDULED', 'ALL',
]);

function isSystemLabel(label: string): boolean {
  return SYSTEM_LABELS_SET.has(label.toUpperCase());
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
    maxHeight: '70%',
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
    marginBottom: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  closeButton: {
    padding: 4,
  },
  list: {
    maxHeight: 300,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  labelDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  labelName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  cancelButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
  },
  saveButton: {
    flex: 1,
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  saveText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
