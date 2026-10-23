import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { FormField, FormScreen } from '@/components/form';
import { RecordRefField } from '@/components/record-ref-field';
import { api } from '@/services/api';
import type { RecordKind, RecordRef } from '@/services/notes';
import { useI18n } from '@/lib/i18n';
import { LOGGABLE_ACTIVITY_TYPES, type LoggableActivityType } from '@/lib/crm';
import { describeError, optionalText, validateActivity, type FormErrors } from '@/lib/validation';

/**
 * Log a call, email, meeting or note. Opened from a record (`recordKind`,
 * `recordId`, `recordName`) or a deal (`opportunityId`) it is linked to them.
 */
export default function LogActivityScreen() {
  const params = useLocalSearchParams<{
    recordKind?: RecordKind;
    recordId?: string;
    recordName?: string;
    opportunityId?: string;
  }>();
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [type, setType] = useState<LoggableActivityType>('call');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [record, setRecord] = useState<RecordRef | undefined>(
    params.recordKind && params.recordId ? { kind: params.recordKind, id: params.recordId, name: params.recordName } : undefined,
  );
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
      record,
      opportunityId: params.opportunityId || undefined,
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
        <RecordRefField label={t.activity.record} value={record} onChange={setRecord} />
      </FormScreen>
    </>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  chipText: { fontSize: 14, fontWeight: '500' },
});
