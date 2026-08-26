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
import { useI18n } from '@/lib/i18n';

export default function NewContactScreen() {
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();

  const ROLES = [
    { label: t.contacts.customer, value: 'customer' },
    { label: t.contacts.supplier, value: 'supplier' },
    { label: t.contacts.both, value: 'both' },
  ];

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
      setNameError(t.contactNew.nameError);
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
      toast.success(t.contactNew.created);
      router.replace(`/contacts/${contact.id}` as never);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.contactNew.createFailed);
    } finally {
      setSubmitting(false);
    }
  }, [fullName, email, phone, vatNumber, role, router, toast, t]);

  return (
    <Screen header={<ScreenHeader title={t.contactNew.title} showBack />}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <SectionCard title={t.contactNew.contact}>
            <Input
              label={t.contactNew.name}
              value={fullName}
              onChangeText={(text) => {
                setFullName(text);
                if (nameError) setNameError(undefined);
              }}
              placeholder={t.contactNew.namePlaceholder}
              error={nameError}
              autoCapitalize="words"
            />
            <Select
              label={t.contactNew.role}
              value={role}
              onValueChange={setRole}
              options={ROLES}
            />
          </SectionCard>

          <SectionCard title={t.contactNew.details}>
            <Input
              label={t.contactNew.email}
              value={email}
              onChangeText={setEmail}
              placeholder={t.contactNew.emailPlaceholder}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label={t.contactNew.phone}
              value={phone}
              onChangeText={setPhone}
              placeholder={t.contactNew.phonePlaceholder}
              keyboardType="phone-pad"
            />
            <Input
              label={t.contactNew.vatNumber}
              value={vatNumber}
              onChangeText={setVatNumber}
              placeholder={t.contactNew.vatNumberPlaceholder}
              autoCapitalize="characters"
              autoCorrect={false}
            />
          </SectionCard>

          <Button
            title={t.contactNew.create}
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
