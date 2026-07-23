import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
} from 'react-native';
import MaterialSpinner from './MaterialSpinner';
import CenteredModalShell from './CenteredModalShell';
import { X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import appApi from '@/services/app-api';
import { useMail } from '@/contexts/MailContext';

const LABEL_COLORS = [
  { name: 'Red', value: '#EF4444' },
  { name: 'Orange', value: '#F97316' },
  { name: 'Yellow', value: '#EAB308' },
  { name: 'Green', value: '#22C55E' },
  { name: 'Teal', value: '#14B8A6' },
  { name: 'Blue', value: '#3B82F6' },
  { name: 'Purple', value: '#8B5CF6' },
  { name: 'Pink', value: '#EC4899' },
];

interface CreateLabelDialogProps {
  visible: boolean;
  onClose: () => void;
  accountId: string;
}

export default function CreateLabelDialog({ visible, onClose, accountId }: CreateLabelDialogProps) {
  const { colors } = useTheme();
  const { refreshLabels } = useMail();

  const [name, setName] = useState('');
  const [selectedColor, setSelectedColor] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setName('');
    setSelectedColor(undefined);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setSaving(true);
    try {
      // AI Auto-Labeling has been removed along with the AI backend — labels
      // are created as plain (non-AI) labels now.
      const payload: any = {
        name: trimmed,
        color: selectedColor,
        aiEnabled: false,
      };

      await appApi.mailLabels.create({ accountId, ...payload });
      await refreshLabels();
      resetForm();
      onClose();
    } catch (err: any) {
      const raw = err?.message || '';
      const msg = typeof raw === 'string' && raw.includes('409')
        ? 'A label with this name already exists'
        : 'Failed to create label';
      Alert.alert('Error', msg);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <CenteredModalShell visible={visible} onClose={handleClose} keyboardAvoiding>
            <View style={[styles.dialog, { backgroundColor: colors.background }]}>
              {/* Header */}
              <View style={styles.header}>
                <Text style={[styles.title, { color: colors.text }]}>Create Label</Text>
                <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
                  <X size={20} color={colors.muted} />
                </TouchableOpacity>
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                style={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
              >
                {/* Name input */}
                <View style={styles.field}>
                  <Text style={[styles.fieldLabel, { color: colors.muted }]}>Name</Text>
                  <TextInput
                    style={[styles.input, { color: colors.text, borderColor: colors.border || '#E5E7EB', backgroundColor: colors.card || '#F9FAFB' }]}
                    value={name}
                    onChangeText={setName}
                    placeholder="Label name"
                    placeholderTextColor={colors.muted}
                    autoFocus
                    maxLength={100}
                    returnKeyType="done"
                  />
                </View>

                {/* Color picker */}
                <View style={styles.field}>
                  <Text style={[styles.fieldLabel, { color: colors.muted }]}>Color</Text>
                  <View style={styles.colorGrid}>
                    {LABEL_COLORS.map((c) => (
                      <TouchableOpacity
                        key={c.value}
                        onPress={() => setSelectedColor(selectedColor === c.value ? undefined : c.value)}
                        style={[
                          styles.colorSwatch,
                          { backgroundColor: c.value },
                          selectedColor === c.value && styles.colorSwatchSelected,
                        ]}
                      >
                        {selectedColor === c.value && (
                          <Text style={styles.colorCheck}>&#10003;</Text>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* AI Auto-Labeling is unavailable — the AI backend has been removed. */}
                <View style={[styles.aiSection, { borderColor: colors.border || '#E5E7EB' }]}>
                  <Text style={[styles.aiUnavailableText, { color: colors.muted }]}>
                    AI is currently unavailable. This label will match emails you apply it to manually.
                  </Text>
                </View>
              </ScrollView>

              {/* Actions */}
              <View style={styles.actions}>
                <TouchableOpacity
                  style={[styles.cancelButton, { borderColor: colors.border || '#E5E7EB' }]}
                  onPress={handleClose}
                >
                  <Text style={[styles.cancelText, { color: colors.text }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.createButton, !name.trim() && styles.createButtonDisabled]}
                  onPress={handleCreate}
                  disabled={!name.trim() || saving}
                >
                  {saving ? (
                    <MaterialSpinner size={18} strokeWidth={2.4} color="#FFFFFF" spinning />
                  ) : (
                    <Text style={styles.createText}>Create</Text>
                  )}
                </TouchableOpacity>
              </View>
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
    width: 340,
    maxHeight: '85%',
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
    marginBottom: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  closeButton: {
    padding: 4,
  },
  scrollContent: {
    flexGrow: 0,
  },
  field: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: 11,
    marginBottom: 6,
    marginTop: -2,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 72,
  },
  colorGrid: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  colorSwatch: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  colorSwatchSelected: {
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  colorCheck: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  // AI section (unavailable notice)
  aiSection: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  aiUnavailableText: {
    fontSize: 13,
    lineHeight: 18,
  },
  // Actions
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
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
  createButton: {
    flex: 1,
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  createButtonDisabled: {
    opacity: 0.4,
  },
  createText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
