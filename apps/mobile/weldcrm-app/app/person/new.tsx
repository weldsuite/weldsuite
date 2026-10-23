import React, { useState } from 'react';
import { Alert, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Building2, ChevronRight } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { CompanyPicker } from '@/components/company-picker';
import { FormField, FormScreen } from '@/components/form';
import { api, type CompanyRecord } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { describeError, optionalText, validatePerson, type FormErrors } from '@/lib/validation';

type Field = 'firstName' | 'email';

/** New person; `companyId` + `companyName` preselect the company they work at. */
export default function NewPersonScreen() {
  const params = useLocalSearchParams<{ companyId?: string; companyName?: string }>();
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [isLead, setIsLead] = useState(false);
  const [company, setCompany] = useState<Pick<CompanyRecord, 'id' | 'name'> | null>(
    params.companyId ? { id: params.companyId, name: params.companyName ?? '' } : null,
  );
  const [pickerVisible, setPickerVisible] = useState(false);
  const [errors, setErrors] = useState<FormErrors<Field>>({});
  const [submitting, setSubmitting] = useState(false);

  const message = (field: Field, label: string) => {
    const error = errors[field];
    return error ? describeError(t, error, label) : null;
  };

  const handleSubmit = async () => {
    const found = validatePerson({ firstName, lastName, email });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const res = await api.createPerson({
      firstName: optionalText(firstName),
      lastName: optionalText(lastName),
      jobTitle: optionalText(jobTitle),
      email: optionalText(email),
      phone: optionalText(phone),
      mobile: optionalText(mobile),
      isLead: isLead || undefined,
      companyId: company?.id,
    });
    setSubmitting(false);

    if (res.success && res.data) {
      toast.success(t.person.createdToast);
      router.replace({ pathname: '/person/[id]', params: { id: res.data.id } });
    } else if (res.existingPersonId) {
      // Someone in the CRM already has this email: offer them instead of a duplicate, like the web.
      const existingId = res.existingPersonId;
      Alert.alert(t.person.duplicateTitle, t.person.duplicateMessage, [
        { text: t.common.cancel, style: 'cancel' },
        { text: t.person.openExisting, onPress: () => router.replace({ pathname: '/person/[id]', params: { id: existingId } }) },
      ]);
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.person.createFailed);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FormScreen
        title={t.person.newTitle}
        onClose={() => router.back()}
        submitLabel={t.common.create}
        onSubmit={() => void handleSubmit()}
        submitting={submitting}
      >
        <FormField
          label={t.person.firstName}
          required
          value={firstName}
          onChangeText={setFirstName}
          placeholder={t.person.firstNamePlaceholder}
          error={message('firstName', t.person.firstName)}
          autoCapitalize="words"
        />
        <FormField
          label={t.person.lastName}
          value={lastName}
          onChangeText={setLastName}
          placeholder={t.person.lastNamePlaceholder}
          autoCapitalize="words"
        />
        <FormField
          label={t.person.jobTitle}
          value={jobTitle}
          onChangeText={setJobTitle}
          placeholder={t.person.jobTitlePlaceholder}
          autoCapitalize="sentences"
        />
        <FormField
          label={t.person.email}
          value={email}
          onChangeText={setEmail}
          placeholder={t.person.emailPlaceholder}
          error={message('email', t.person.email)}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FormField
          label={t.person.phone}
          value={phone}
          onChangeText={setPhone}
          placeholder={t.person.phonePlaceholder}
          keyboardType="phone-pad"
        />
        <FormField
          label={t.person.mobile}
          value={mobile}
          onChangeText={setMobile}
          placeholder={t.person.mobilePlaceholder}
          keyboardType="phone-pad"
        />
        <View style={styles.switchRow}>
          <Text style={[styles.switchLabel, { color: colors.text }]}>{t.records.isLead}</Text>
          <Switch value={isLead} onValueChange={setIsLead} accessibilityLabel={t.records.isLead} />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.muted }]}>{t.person.company}</Text>
          <TouchableOpacity
            style={[styles.select, { borderColor: colors.divider, backgroundColor: colors.background }]}
            onPress={() => setPickerVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t.person.company}
          >
            <Building2 size={16} color={colors.muted} />
            <Text style={[styles.selectText, { color: company ? colors.text : colors.muted }]} numberOfLines={1}>
              {company ? company.name : t.person.selectCompany}
            </Text>
            {company ? (
              <TouchableOpacity
                onPress={() => setCompany(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t.common.clear}
              >
                <Text style={[styles.clear, { color: colors.muted }]}>{t.common.clear}</Text>
              </TouchableOpacity>
            ) : (
              <ChevronRight size={16} color={colors.muted} />
            )}
          </TouchableOpacity>
        </View>
      </FormScreen>
      <CompanyPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelect={(selected) => {
          setCompany(selected);
          setPickerVisible(false);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectText: { flex: 1, fontSize: 15 },
  clear: { fontSize: 13, textDecorationLine: 'underline' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  switchLabel: { fontSize: 15 },
});
