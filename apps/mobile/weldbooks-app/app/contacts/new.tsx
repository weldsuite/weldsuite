/**
 * Create an accounting contact.
 *
 * Until now contacts could only be created implicitly, as a side effect of
 * typing a new name on an invoice or bill (`resolveContactId`). This gives the
 * flow a front door so email, phone, tax number, address and role can be set up
 * front rather than left blank on an auto-created record.
 *
 * A US contact has an address (a state and ZIP when any of it is given) and no
 * tax-ID field: customers have none to give, and a vendor's TIN, W-9 and 1099
 * settings are write-only on the server and entered on the web, never on a
 * phone.
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
import { AddressFields, type AddressErrors } from '@/components/address-fields';
import { useJurisdiction } from '@/hooks/useJurisdiction';
import { useI18n } from '@/lib/i18n';
import { describeApiError } from '@/lib/sales-tax';
import { EMPTY_ADDRESS, isAddressBlank, toApiAddress, usAddressProblems, type AddressDraft } from '@/lib/us';

export default function NewContactScreen() {
  const router = useRouter();
  const toast = useToast();
  const { t, format } = useI18n();
  const { isUs, labels, terms } = useJurisdiction();

  const ROLES = [
    { label: t.contacts.customer, value: 'customer' },
    { label: labels.supplier, value: 'supplier' },
    { label: format(t.contacts.both, terms), value: 'both' },
  ];

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [taxId, setTaxId] = useState('');
  const [role, setRole] = useState('customer');
  const [address, setAddress] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [addressErrors, setAddressErrors] = useState<AddressErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();

  const handleSave = useCallback(async () => {
    const trimmed = fullName.trim();
    if (!trimmed) {
      setNameError(t.contactNew.nameError);
      return;
    }
    if (isUs) {
      // A partly filled address is checked; a blank one is simply left out.
      const problems = usAddressProblems(address);
      setAddressErrors(problems);
      if (Object.keys(problems).length > 0) return;
    }

    setSubmitting(true);
    try {
      const contact = await api.createContact({
        fullName: trimmed,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        vatNumber: isUs ? undefined : taxId.trim() || undefined,
        role,
        billingAddress: isUs && !isAddressBlank(address) ? toApiAddress(address) : undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success(t.contactNew.created);
      router.replace(`/contacts/${contact.id}` as never);
    } catch (err) {
      toast.error(describeApiError(err, t, t.contactNew.createFailed));
    } finally {
      setSubmitting(false);
    }
  }, [fullName, email, phone, taxId, role, address, isUs, router, toast, t]);

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
              placeholder={isUs ? t.examples.companyUs : t.contactNew.namePlaceholder}
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
              placeholder={isUs ? t.examples.phoneUs : t.contactNew.phonePlaceholder}
              keyboardType="phone-pad"
            />
            {isUs ? null : (
              <Input
                label={labels.taxId}
                value={taxId}
                onChangeText={setTaxId}
                placeholder={labels.taxIdPlaceholder}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            )}
          </SectionCard>

          {isUs ? (
            <SectionCard title={t.contactNew.address}>
              <AddressFields
                value={address}
                onChange={(next) => {
                  setAddress(next);
                  setAddressErrors({});
                }}
                errors={addressErrors}
              />
            </SectionCard>
          ) : null}

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
