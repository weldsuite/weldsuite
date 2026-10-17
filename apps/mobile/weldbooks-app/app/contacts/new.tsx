/**
 * Create an accounting contact.
 *
 * Until now contacts could only be created implicitly, as a side effect of
 * typing a new name on an invoice or bill (`resolveContactId`). This gives the
 * flow a front door so email, phone, tax number, address and role can be set up
 * front rather than left blank on an auto-created record.
 *
 * A contact is a company or a person, as on the web: books-api files it under
 * the matching WeldCRM record. A company has a name (plus an optional name on
 * invoices) and a tax number; a person has a first and last name and no tax
 * number. Picking an existing CRM record and setting a company's contact person
 * are web-only for now.
 *
 * A US contact has an address (a state and ZIP when any of it is given) and no
 * tax-ID field: customers have none to give, and a vendor's TIN, W-9 and 1099
 * settings are write-only on the server and entered on the web, never on a
 * phone.
 */

import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';

import api from '@/services/api';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { AddressFields, type AddressErrors } from '@/components/address-fields';
import { useJurisdiction } from '@/hooks/useJurisdiction';
import { useI18n } from '@/lib/i18n';
import { describeApiError } from '@/lib/sales-tax';
import { EMPTY_ADDRESS, isAddressBlank, toApiAddress, usAddressProblems, type AddressDraft } from '@/lib/us';
import {
  EMPTY_IDENTITY,
  NAME_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  contactIdentityProblems,
  toContactIdentityPayload,
  type ContactIdentityDraft,
  type ContactIdentityProblems,
} from '@/lib/contact-kind';

type IdentityTextField = Exclude<keyof ContactIdentityDraft, 'kind'>;

export default function NewContactScreen() {
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { isUs, labels, terms } = useJurisdiction();

  const ROLES = [
    { label: t.contacts.customer, value: 'customer' },
    { label: labels.supplier, value: 'supplier' },
    { label: format(t.contacts.both, terms), value: 'both' },
  ];

  const KINDS = [
    { label: t.contacts.kinds.company, value: 'company' },
    { label: t.contacts.kinds.person, value: 'person' },
  ];

  const [identity, setIdentity] = useState<ContactIdentityDraft>({ ...EMPTY_IDENTITY });
  const [identityErrors, setIdentityErrors] = useState<ContactIdentityProblems>({});
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('customer');
  const [address, setAddress] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [addressErrors, setAddressErrors] = useState<AddressErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const isCompany = identity.kind === 'company';

  /** Change handler for one identity field; typing clears the name error. */
  const setIdentityField = useCallback(
    (field: IdentityTextField) => (text: string) => {
      setIdentity((prev) => ({ ...prev, [field]: text }));
      setIdentityErrors({});
    },
    [],
  );

  const handleSave = useCallback(async () => {
    const problems = contactIdentityProblems(identity);
    setIdentityErrors(problems);
    if (Object.keys(problems).length > 0) return;
    if (isUs) {
      // A partly filled address is checked; a blank one is simply left out.
      const addressProblems = usAddressProblems(address);
      setAddressErrors(addressProblems);
      if (Object.keys(addressProblems).length > 0) return;
    }

    setSubmitting(true);
    try {
      const contact = await api.createContact({
        ...toContactIdentityPayload(identity, { withTaxId: !isUs }),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
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
  }, [identity, email, phone, role, address, isUs, router, toast, t]);

  return (
    <Screen header={<ScreenHeader title={t.contactNew.title} showBack />}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <SectionCard title={t.contactNew.contact}>
            <SegmentedControl
              options={KINDS}
              value={identity.kind}
              onValueChange={(value) => {
                setIdentity((prev) => ({ ...prev, kind: value === 'person' ? 'person' : 'company' }));
                setIdentityErrors({});
              }}
            />
            <Text style={[styles.kindHelp, { color: colors.mutedForeground }]}>{t.contactNew.kindHelp}</Text>
            {isCompany ? (
              <>
                <Input
                  label={t.contactNew.companyName}
                  value={identity.companyName}
                  onChangeText={setIdentityField('companyName')}
                  placeholder={isUs ? t.examples.companyUs : t.contactNew.companyNamePlaceholder}
                  error={identityErrors.companyName ? t.contactNew.companyNameError : undefined}
                  autoCapitalize="words"
                  maxLength={NAME_MAX_LENGTH}
                />
                <Input
                  label={t.contactNew.nameOnInvoices}
                  value={identity.nameOnInvoices}
                  onChangeText={setIdentityField('nameOnInvoices')}
                  helperText={t.contactNew.nameOnInvoicesHelp}
                  autoCapitalize="words"
                  maxLength={NAME_MAX_LENGTH}
                />
              </>
            ) : (
              <>
                <Input
                  label={t.contactNew.firstName}
                  value={identity.firstName}
                  onChangeText={setIdentityField('firstName')}
                  placeholder={t.contactNew.firstNamePlaceholder}
                  error={identityErrors.personName ? t.contactNew.personNameError : undefined}
                  autoCapitalize="words"
                  autoComplete="given-name"
                  maxLength={PERSON_NAME_MAX_LENGTH}
                />
                <Input
                  label={t.contactNew.lastName}
                  value={identity.lastName}
                  onChangeText={setIdentityField('lastName')}
                  placeholder={t.contactNew.lastNamePlaceholder}
                  autoCapitalize="words"
                  autoComplete="family-name"
                  maxLength={PERSON_NAME_MAX_LENGTH}
                />
              </>
            )}
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
              placeholder={isCompany ? t.contactNew.emailPlaceholder : t.contactNew.emailPlaceholderPerson}
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
            {/* A person has no VAT or registration number; books-api refuses one. */}
            {isUs || !isCompany ? null : (
              <Input
                label={labels.taxId}
                value={identity.taxId}
                onChangeText={setIdentityField('taxId')}
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
  kindHelp: { fontSize: 12, lineHeight: 17, marginTop: 6, marginBottom: 10 },
  submit: { marginHorizontal: 12, marginTop: 20 },
});
