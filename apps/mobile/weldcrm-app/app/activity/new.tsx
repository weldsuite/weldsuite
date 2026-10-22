import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { Building2, ChevronRight } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { CompanyPicker } from '@/components/company-picker';
import { FormField, FormScreen } from '@/components/form';
import { api, type CompanyRecord } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { LOGGABLE_ACTIVITY_TYPES, type LoggableActivityType } from '@/lib/crm';
import { describeError, optionalText, validateActivity, type FormErrors } from '@/lib/validation';

export default function LogActivityScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [type, setType] = useState<LoggableActivityType>('call');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [company, setCompany] = useState<CompanyRecord | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [errors, setErrors] = useState<FormErrors<'subject'>>({});
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const found = validateActivity({ subject });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const res = await api.logActivity({
      type,
      subject,
      description: optionalText(description),
      companyId: company?.id,
    });
    setSubmitting(false);

    if (res.success) {
      toast.success(t.activity.loggedToast);
      router.back();
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.activity.logFailed);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FormScreen
        title={t.activity.title}
        onClose={() => router.back()}
        submitLabel={t.activity.log}
        onSubmit={() => void handleSubmit()}
        submitting={submitting}
      >
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.muted }]}>{t.activity.type}</Text>
          <View style={styles.chips}>
            {LOGGABLE_ACTIVITY_TYPES.map((option) => {
              const active = option === type;
              return (
                <TouchableOpacity
                  key={option}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.text : colors.background,
                      borderColor: active ? colors.text : colors.divider,
                    },
                  ]}
                  onPress={() => setType(option)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.chipText, { color: active ? colors.background : colors.text }]}>
                    {t.activity.types[option]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <FormField
          label={t.activity.subject}
          required
          value={subject}
          onChangeText={setSubject}
          placeholder={t.activity.subjectPlaceholder}
          error={errors.subject ? describeError(t, errors.subject, t.activity.subject) : null}
          autoCapitalize="sentences"
        />
        <FormField
          label={t.activity.description}
          value={description}
          onChangeText={setDescription}
          placeholder={t.activity.descriptionPlaceholder}
          multiline
          numberOfLines={4}
        />

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.muted }]}>{t.activity.company}</Text>
          <TouchableOpacity
            style={[styles.select, { borderColor: colors.divider, backgroundColor: colors.background }]}
            onPress={() => setPickerVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t.activity.company}
          >
            <Building2 size={16} color={colors.muted} />
            <Text style={[styles.selectText, { color: company ? colors.text : colors.muted }]} numberOfLines={1}>
              {company ? company.name : t.common.select}
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  chipText: { fontSize: 14, fontWeight: '500' },
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
});
