import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ChevronLeft, ChevronDown } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#10B981' },
  { value: 'normal', label: 'Normal', color: '#6B7280' },
  { value: 'high', label: 'High', color: '#F97316' },
  { value: 'urgent', label: 'Urgent', color: '#EF4444' },
];

export default function NewTicketScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);

  const handleSubmit = async () => {
    if (!subject.trim()) {
      toast.error('Please enter a subject');
      return;
    }

    try {
      setSubmitting(true);
      const response = await api.createTicket({
        subject: subject.trim(),
        description: description.trim() || undefined,
        priority,
        contactName: customerName.trim() || undefined,
        contactEmail: customerEmail.trim() || undefined,
      });

      if (response.success && response.data) {
        toast.success('Ticket created successfully');
        router.replace(`/helpdesk/ticket/${response.data.id}` as any);
      } else {
        toast.error(response.error || 'Failed to create ticket');
      }
    } catch (error) {
      console.error('Error creating ticket:', error);
      toast.error('Failed to create ticket');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedPriority = PRIORITY_OPTIONS.find(p => p.value === priority) || PRIORITY_OPTIONS[1];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <SafeAreaView edges={['top']} style={{ backgroundColor: colors.background }}>
        <View style={[styles.header, { borderBottomColor: colors.divider }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>New Ticket</Text>
          <View style={styles.headerSpacer} />
        </View>
      </SafeAreaView>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.form}>
          {/* Customer Name */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Customer Name</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.divider }]}
              placeholder="Enter customer name (optional)"
              placeholderTextColor={colors.muted}
              value={customerName}
              onChangeText={setCustomerName}
            />
          </View>

          {/* Customer Email */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Customer Email</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.divider }]}
              placeholder="Enter customer email (optional)"
              placeholderTextColor={colors.muted}
              value={customerEmail}
              onChangeText={setCustomerEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          {/* Subject */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Subject *</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.divider }]}
              placeholder="Enter ticket subject"
              placeholderTextColor={colors.muted}
              value={subject}
              onChangeText={setSubject}
            />
          </View>

          {/* Description */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Description</Text>
            <TextInput
              style={[styles.textArea, { backgroundColor: colors.card, color: colors.text, borderColor: colors.divider }]}
              placeholder="Enter ticket description"
              placeholderTextColor={colors.muted}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          {/* Priority */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Priority</Text>
            <TouchableOpacity
              style={[styles.pickerButton, { backgroundColor: colors.card, borderColor: colors.divider }]}
              onPress={() => setShowPriorityPicker(true)}
            >
              <View style={styles.pickerContent}>
                <View style={[styles.priorityDot, { backgroundColor: selectedPriority.color }]} />
                <Text style={[styles.pickerText, { color: colors.text }]}>{selectedPriority.label}</Text>
              </View>
              <ChevronDown size={20} color={colors.muted} />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* Submit Button */}
      <SafeAreaView edges={['bottom']} style={{ backgroundColor: colors.background }}>
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.submitButtonText}>Create Ticket</Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Priority Picker Modal */}
      <Modal
        visible={showPriorityPicker}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowPriorityPicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowPriorityPicker(false)}>
          <View style={[styles.pickerModal, { backgroundColor: colors.card }]}>
            <Text style={[styles.pickerTitle, { color: colors.text }]}>Select Priority</Text>
            {PRIORITY_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.value}
                style={[
                  styles.pickerOption,
                  priority === option.value && { backgroundColor: colors.background },
                ]}
                onPress={() => {
                  setPriority(option.value);
                  setShowPriorityPicker(false);
                }}
              >
                <View style={[styles.priorityDot, { backgroundColor: option.color }]} />
                <Text style={[styles.pickerOptionText, { color: colors.text }]}>{option.label}</Text>
                {priority === option.value && (
                  <Text style={[styles.checkmark, { color: '#3B82F6' }]}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 4,
    marginRight: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 32,
  },
  scrollView: {
    flex: 1,
  },
  form: {
    padding: 16,
    gap: 20,
  },
  formGroup: {
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 120,
  },
  pickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  pickerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  priorityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pickerText: {
    fontSize: 15,
  },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  submitButton: {
    backgroundColor: '#000000',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  pickerModal: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 12,
    padding: 16,
  },
  pickerTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  pickerOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 10,
  },
  pickerOptionText: {
    flex: 1,
    fontSize: 15,
  },
  checkmark: {
    fontSize: 16,
    fontWeight: '600',
  },
});
