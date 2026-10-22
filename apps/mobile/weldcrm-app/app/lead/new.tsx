import React, { useState } from 'react';
import { router, Stack } from 'expo-router';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { FormField, FormScreen } from '@/components/form';
import { api } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { describeError, optionalText, validateLead, type FormErrors } from '@/lib/validation';

export default function NewLeadScreen() {
  const { t } = useI18n();
  const toast = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<FormErrors<'email'>>({});
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const found = validateLead({ email });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const res = await api.createLead({
      firstName: optionalText(firstName),
      lastName: optionalText(lastName),
      email,
      companyName: optionalText(companyName),
      phone: optionalText(phone),
    });
    setSubmitting(false);

    if (res.success) {
      toast.success(t.leads.createdToast);
      router.back();
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.leads.createFailed);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FormScreen
        title={t.leads.newTitle}
        onClose={() => router.back()}
        submitLabel={t.common.create}
        onSubmit={() => void handleSubmit()}
        submitting={submitting}
      >
        <FormField
          label={t.leads.email}
          required
          value={email}
          onChangeText={setEmail}
          placeholder={t.leads.emailPlaceholder}
          error={errors.email ? describeError(t, errors.email, t.leads.email) : null}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FormField
          label={t.leads.firstName}
          value={firstName}
          onChangeText={setFirstName}
          placeholder={t.leads.firstNamePlaceholder}
          autoCapitalize="words"
        />
        <FormField
          label={t.leads.lastName}
          value={lastName}
          onChangeText={setLastName}
          placeholder={t.leads.lastNamePlaceholder}
          autoCapitalize="words"
        />
        <FormField
          label={t.leads.company}
          value={companyName}
          onChangeText={setCompanyName}
          placeholder={t.leads.companyPlaceholder}
          autoCapitalize="words"
        />
        <FormField
          label={t.leads.phone}
          value={phone}
          onChangeText={setPhone}
          placeholder={t.leads.phonePlaceholder}
          keyboardType="phone-pad"
        />
      </FormScreen>
    </>
  );
}
