import React, { useState } from 'react';
import { router, Stack } from 'expo-router';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { FormField, FormScreen } from '@/components/form';
import { api } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { describeError, optionalText, validateCompany, type FormErrors } from '@/lib/validation';

type Field = 'name' | 'email';

export default function NewCompanyScreen() {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [website, setWebsite] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<FormErrors<Field>>({});
  const [submitting, setSubmitting] = useState(false);

  const message = (field: Field, label: string) => {
    const error = errors[field];
    return error ? describeError(t, error, label) : null;
  };

  const handleSubmit = async () => {
    const found = validateCompany({ name, email });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const res = await api.createCompany({
      name: name.trim(),
      industry: optionalText(industry),
      website: optionalText(website),
      email: optionalText(email),
      phone: optionalText(phone),
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
      </FormScreen>
    </>
  );
}
