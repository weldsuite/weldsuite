import React, { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { FormField, FormScreen } from '@/components/form';
import { api } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import {
  checkEmployeeCount,
  checkWebsite,
  describeError,
  optionalText,
  validateCompany,
  type FormErrors,
} from '@/lib/validation';

type Field = 'name' | 'email' | 'website' | 'employeeCount';

export default function NewCompanyScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [website, setWebsite] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [employeeCount, setEmployeeCount] = useState('');
  const [isLead, setIsLead] = useState(false);
  const [errors, setErrors] = useState<FormErrors<Field>>({});
  const [submitting, setSubmitting] = useState(false);

  const message = (field: Field, label: string) => {
    const error = errors[field];
    return error ? describeError(t, error, label) : null;
  };

  const handleSubmit = async () => {
    const found: FormErrors<Field> = { ...validateCompany({ name, email }) };
    const websiteError = checkWebsite(website);
    if (websiteError) found.website = websiteError;
    const employeesError = checkEmployeeCount(employeeCount);
    if (employeesError) found.employeeCount = employeesError;
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const res = await api.createCompany({
      name: name.trim(),
      industry: optionalText(industry),
      website: optionalText(website),
      email: optionalText(email),
      phone: optionalText(phone),
      employeeCount: optionalText(employeeCount),
      isLead: isLead || undefined,
    });
    setSubmitting(false);

    if (res.success && res.data) {
      toast.success(t.company.createdToast);
      router.replace({ pathname: '/company/[id]', params: { id: res.data.id } });
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.company.createFailed);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FormScreen
        title={t.company.newTitle}
        onClose={() => router.back()}
        submitLabel={t.common.create}
        onSubmit={() => void handleSubmit()}
        submitting={submitting}
      >
        <FormField
          label={t.company.name}
          required
          value={name}
          onChangeText={setName}
          placeholder={t.company.namePlaceholder}
          error={message('name', t.company.name)}
          autoCapitalize="words"
        />
        <FormField
          label={t.company.industry}
          value={industry}
          onChangeText={setIndustry}
          placeholder={t.company.industryPlaceholder}
          autoCapitalize="sentences"
        />
        <FormField
          label={t.company.website}
          value={website}
          onChangeText={setWebsite}
          placeholder={t.company.websitePlaceholder}
          error={message('website', t.company.website)}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FormField
          label={t.company.email}
          value={email}
          onChangeText={setEmail}
          placeholder={t.company.emailPlaceholder}
          error={message('email', t.company.email)}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FormField
          label={t.company.phone}
          value={phone}
          onChangeText={setPhone}
          placeholder={t.company.phonePlaceholder}
          keyboardType="phone-pad"
        />
        <FormField
          label={t.records.employees}
          value={employeeCount}
          onChangeText={setEmployeeCount}
          placeholder={t.records.employeesPlaceholder}
          error={message('employeeCount', t.records.employees)}
          keyboardType="numbers-and-punctuation"
        />
        <View style={styles.switchRow}>
          <Text style={[styles.switchLabel, { color: colors.text }]}>{t.records.isLead}</Text>
          <Switch value={isLead} onValueChange={setIsLead} accessibilityLabel={t.records.isLead} />
        </View>
      </FormScreen>
    </>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  switchLabel: { fontSize: 15 },
});
