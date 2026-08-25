/**
 * Create an accounting contact.
 *
 * Until now contacts could only be created implicitly, as a side effect of
 * typing a new name on an invoice or bill (`resolveContactId`). This gives the
 * flow a front door so email, phone, VAT number and role can be set up front
 * rather than left blank on an auto-created record.
 */

import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Button } from '@weldsuite/mobile-ui/components/Button';

import api from '@/services/api';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';

const ROLES = [
  { label: 'Customer', value: 'customer' },
  { label: 'Supplier', value: 'supplier' },
  { label: 'Customer & supplier', value: 'both' },
];

export default function NewContactScreen() {
  const router = useRouter();
  const toast = useToast();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [vatNumber, setVatNumber] = useState('');
  const [role, setRole] = useState('customer');
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();

  const handleSave = useCallback(async () => {
    const trimmed = fullName.trim();
    if (!trimmed) {
      setNameError('Enter a name');
      return;
    }

    setSubmitting(true);
    try {
      const contact = await api.createContact({
        fullName: trimmed,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        vatNumber: vatNumber.trim() || undefined,
        role,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success('Contact created');
      router.replace(`/contacts/${contact.id}` as never);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the contact');
    } finally {
      setSubmitting(false);
    }
  }, [fullName, email, phone, vatNumber, role, router, toast]);

  return (
    <Screen header={<ScreenHeader title="New contact" showBack />}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <SectionCard title="Contact">
            <Input
              label="Name"
              value={fullName}
              onChangeText={(text) => {
                setFullName(text);
                if (nameError) setNameError(undefined);
              }}
              placeholder="Acme B.V."
              error={nameError}
              autoCapitalize="words"
            />
            <Select label="Role" value={role} onValueChange={setRole} options={ROLES} />
          </SectionCard>

          <SectionCard title="Contact details">
            <Input
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="billing@acme.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label="Phone"
              value={phone}
              onChangeText={setPhone}
              placeholder="+31 20 123 4567"
              keyboardType="phone-pad"
            />
            <Input
              label="VAT number"
              value={vatNumber}
              onChangeText={setVatNumber}
              placeholder="NL123456789B01"
              autoCapitalize="characters"
              autoCorrect={false}
            />
          </SectionCard>

          <Button
            title="Create contact"
            onPress={handleSave}
            loading={submitting}
            fullWidth
            style={styles.submit}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingBottom: 40, paddingTop: 4 },
  submit: { marginHorizontal: 12, marginTop: 20 },
});
