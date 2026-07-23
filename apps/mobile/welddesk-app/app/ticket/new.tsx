import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowLeft, ChevronDown } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';

const PRIORITIES = [
  { key: 'low', label: 'Low', color: '#6B7280' },
  { key: 'normal', label: 'Normal', color: '#3B82F6' },
  { key: 'high', label: 'High', color: '#F59E0B' },
  { key: 'urgent', label: 'Urgent', color: '#EF4444' },
];

export default function NewTicketScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [priority, setPriority] = useState('normal');
  const [showPriority, setShowPriority] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!subject.trim()) { setError('Subject is required'); return; }
    if (!description.trim()) { setError('Description is required'); return; }

    setSubmitting(true);
    setError('');

    try {
      const response = await api.createTicket({
        subject: subject.trim(),
        description: description.trim(),
        customerEmail: customerEmail.trim() || undefined,
        priority,
        channel: 'ticket',
      });

      if (response.success && response.data?.id) {
        router.replace(`/ticket/${response.data.id}`);
      } else {
        setError('Failed to create ticket. Please try again.');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedPriority = PRIORITIES.find((p) => p.key === priority)!;

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>New Ticket</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView style={styles.form} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <Text style={[styles.label, { color: colors.text }]}>Subject</Text>
        <TextInput
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
          value={subject}
          onChangeText={setSubject}
          placeholder="What's this about?"
          placeholderTextColor={colors.muted}
        />

        <Text style={[styles.label, { color: colors.text }]}>Customer Email</Text>
        <TextInput
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
          value={customerEmail}
          onChangeText={setCustomerEmail}
          placeholder="customer@example.com (optional)"
          placeholderTextColor={colors.muted}
          keyboardType="email-address"
          autoCapitalize="none"
        />

        <Text style={[styles.label, { color: colors.text }]}>Priority</Text>
        <TouchableOpacity
          style={[styles.input, styles.priorityButton, { borderColor: colors.border, backgroundColor: colors.card }]}
          onPress={() => setShowPriority(!showPriority)}
        >
          <View style={[styles.priorityDot, { backgroundColor: selectedPriority.color }]} />
          <Text style={[styles.priorityText, { color: colors.text }]}>{selectedPriority.label}</Text>
          <ChevronDown size={16} color={colors.muted} />
        </TouchableOpacity>

        {showPriority && (
          <View style={[styles.priorityList, { borderColor: colors.border, backgroundColor: colors.card }]}>
            {PRIORITIES.map((p) => (
              <TouchableOpacity
                key={p.key}
                style={[styles.priorityOption, priority === p.key && { backgroundColor: colors.background }]}
                onPress={() => { setPriority(p.key); setShowPriority(false); }}
              >
                <View style={[styles.priorityDot, { backgroundColor: p.color }]} />
                <Text style={[styles.priorityText, { color: colors.text }]}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={[styles.label, { color: colors.text }]}>Description</Text>
        <TextInput
          style={[styles.input, styles.textArea, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
          value={description}
          onChangeText={setDescription}
          placeholder="Describe the issue..."
          placeholderTextColor={colors.muted}
          multiline
          textAlignVertical="top"
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.submitButton, (!subject.trim() || !description.trim()) && styles.submitDisabled]}
          onPress={handleSubmit}
          disabled={submitting || !subject.trim() || !description.trim()}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitText}>Create Ticket</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 0.5 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  form: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 6, marginTop: 16 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  textArea: { minHeight: 120, paddingTop: 12 },
  priorityButton: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  priorityDot: { width: 10, height: 10, borderRadius: 5 },
  priorityText: { flex: 1, fontSize: 15 },
  priorityList: { borderWidth: 1, borderRadius: 10, marginTop: 4, overflow: 'hidden' },
  priorityOption: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12 },
  error: { color: '#EF4444', fontSize: 14, marginTop: 12, textAlign: 'center' },
  submitButton: { backgroundColor: '#3B82F6', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 24 },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
