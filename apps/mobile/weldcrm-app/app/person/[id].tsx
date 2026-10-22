import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useObserve } from 'expo-observe';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import { Briefcase, FileText, Mail, Phone, User } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { StackHeader } from '@/components/headers';
import {
  RecordField,
  RecordHeaderActions,
  RecordInfoRow,
  RecordLinkRow,
  RecordProfileHeader,
  RecordSectionTitle,
  type RecordFieldConfig,
} from '@/components/record';
import { api, type PersonCompany, type PersonRecord } from '@/services/api';
import { hideAppSplash } from '@/utils/splash';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';
import { describeError, optionalText, validatePerson, type FormErrors } from '@/lib/validation';

interface PersonForm {
  firstName: string;
  lastName: string;
  jobTitle: string;
  email: string;
  phone: string;
  mobile: string;
  notes: string;
}

type EditableField = keyof PersonForm;

const EMPTY_FORM: PersonForm = {
  firstName: '',
  lastName: '',
  jobTitle: '',
  email: '',
  phone: '',
  mobile: '',
  notes: '',
};

const formFromPerson = (person: PersonRecord): PersonForm => ({
  firstName: person.firstName ?? '',
  lastName: person.lastName ?? '',
  jobTitle: person.jobTitle ?? '',
  email: person.email,
  phone: person.phone ?? '',
  mobile: person.mobile ?? '',
  notes: person.notes ?? '',
});

export default function PersonDetailScreen() {
  const { markInteractive } = useObserve();
  const { id, name, edit } = useLocalSearchParams<{ id: string; name?: string; edit?: string }>();
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();

  const [person, setPerson] = useState<PersonRecord | null>(null);
  const [companies, setCompanies] = useState<PersonCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(edit === 'true');
  const [form, setForm] = useState<PersonForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors<'firstName' | 'email'>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [personRes, companiesRes] = await Promise.all([api.getPerson(id), api.getPersonCompanies(id)]);
    if (personRes.success && personRes.data) {
      setPerson(personRes.data);
      setForm(formFromPerson(personRes.data));
    } else {
      toast.error(t.person.loadFailed);
    }
    if (companiesRes.success && companiesRes.data) setCompanies(companiesRes.data);
    setLoading(false);
  }, [id, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  const displayName = person?.name || name || t.person.title;
  const primaryCompany = companies.find((company) => company.isPrimary) ?? companies[0];

  const handleChange = (key: EditableField, text: string) => {
    setForm((prev) => ({ ...prev, [key]: text }));
  };

  const handleCancel = () => {
    if (person) setForm(formFromPerson(person));
    setErrors({});
    setIsEditing(false);
  };

  const handleSave = async () => {
    const found = validatePerson({ firstName: form.firstName, lastName: form.lastName, email: form.email });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    const res = await api.updatePerson(id, {
      firstName: form.firstName,
      lastName: form.lastName,
      jobTitle: form.jobTitle,
      email: form.email,
      phone: form.phone,
      mobile: form.mobile,
      notes: form.notes,
    });
    setSaving(false);

    if (res.success && res.data) {
      setPerson(res.data);
      setForm(formFromPerson(res.data));
      setIsEditing(false);
      toast.success(t.person.savedToast);
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.person.saveFailed);
    }
  };

  const handleDelete = () => {
    Alert.alert(t.person.deleteTitle, interpolate(t.person.deleteMessage, { name: displayName }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const res = await api.deletePerson(id);
            if (res.success) {
              toast.success(t.person.deletedToast);
              router.back();
            } else {
              toast.error(typeof res.error === 'string' ? res.error : t.contacts.deleteFailed);
            }
          })();
        },
      },
    ]);
  };

  const handleCall = () => {
    const number = form.phone || form.mobile;
    if (number) {
      void Linking.openURL(`tel:${number}`);
    } else {
      toast.error(t.common.noPhone);
    }
  };

  const handleEmail = () => {
    if (form.email) void Linking.openURL(`mailto:${form.email}`);
  };

  const header = (
    <StackHeader
      title={isEditing ? t.person.editTitle : displayName}
      onBack={() => router.back()}
      right={
        <RecordHeaderActions
          isEditing={isEditing}
          saving={saving}
          onCancel={handleCancel}
          onSave={() => void handleSave()}
          onEdit={() => setIsEditing(true)}
          onDelete={handleDelete}
        />
      }
    />
  );

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={displayName} onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      </View>
    );
  }

  if (!person) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={displayName} onBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={[styles.empty, { color: colors.muted }]}>{t.person.loadFailed}</Text>
        </View>
      </View>
    );
  }

  const fields: RecordFieldConfig<EditableField>[] = [
    { key: 'firstName', label: t.person.firstName, icon: User, placeholder: t.person.firstNamePlaceholder, required: true },
    { key: 'lastName', label: t.person.lastName, icon: User, placeholder: t.person.lastNamePlaceholder },
    { key: 'jobTitle', label: t.person.jobTitle, icon: Briefcase, placeholder: t.person.jobTitlePlaceholder },
    {
      key: 'email',
      label: t.person.email,
      icon: Mail,
      placeholder: t.person.emailPlaceholder,
      inputProps: { keyboardType: 'email-address', autoCapitalize: 'none', autoCorrect: false },
      viewLink: 'whenFilled',
      onPressView: handleEmail,
    },
    {
      key: 'phone',
      label: t.person.phone,
      icon: Phone,
      placeholder: t.person.phonePlaceholder,
      inputProps: { keyboardType: 'phone-pad' },
      viewLink: 'whenFilled',
      onPressView: handleCall,
    },
    {
      key: 'mobile',
      label: t.person.mobile,
      icon: Phone,
      placeholder: t.person.mobilePlaceholder,
      inputProps: { keyboardType: 'phone-pad' },
    },
    {
      key: 'notes',
      label: t.person.notes,
      icon: FileText,
      placeholder: t.person.notesPlaceholder,
      multiline: true,
      inputProps: { numberOfLines: 4 },
    },
  ];

  const fieldError = (key: EditableField): string | null => {
    if (key === 'firstName' && errors.firstName) return describeError(t, errors.firstName, t.person.firstName);
    if (key === 'email' && errors.email) return describeError(t, errors.email, t.person.email);
    return null;
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ headerShown: false }} />
      {header}

      <ScrollView style={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <RecordProfileHeader
          name={displayName}
          subtitle={[form.jobTitle, primaryCompany?.name].filter(Boolean).join(' · ')}
          isEditing={isEditing}
          onCall={handleCall}
          onEmail={handleEmail}
        />

        <View style={styles.section}>
          <RecordSectionTitle>{isEditing ? t.person.editDetails : t.person.contactInfo}</RecordSectionTitle>
          {fields.map((config) => (
            <RecordField
              key={config.key}
              config={config}
              value={form[config.key]}
              isEditing={isEditing}
              error={fieldError(config.key)}
              onChange={handleChange}
            />
          ))}
        </View>

        {!isEditing && (
          <View style={styles.section}>
            <RecordSectionTitle>{t.person.companies}</RecordSectionTitle>
            {companies.length === 0 ? (
              <Text style={[styles.empty, { color: colors.muted }]}>{t.person.noCompanies}</Text>
            ) : (
              companies.map((company) => (
                <RecordLinkRow
                  key={company.linkId}
                  title={company.name}
                  subtitle={optionalText(company.role) ?? company.industry}
                  badge={company.isPrimary ? t.person.primary : undefined}
                  onPress={() => router.push({ pathname: '/company/[id]', params: { id: company.companyId, name: company.name } })}
                />
              ))
            )}
          </View>
        )}

        {!isEditing && (
          <View style={styles.section}>
            <RecordSectionTitle>{t.person.info}</RecordSectionTitle>
            <RecordInfoRow label={t.person.status}>{labelFor(t.status, person.status ?? 'active')}</RecordInfoRow>
            <RecordInfoRow label={t.person.created}>
              {new Date(person.createdAt).toLocaleDateString(intlLocale)}
            </RecordInfoRow>
            <RecordInfoRow label={t.person.lastUpdated}>
              {new Date(person.updatedAt).toLocaleDateString(intlLocale)}
            </RecordInfoRow>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  section: { paddingHorizontal: 16, paddingVertical: 16 },
  empty: { fontSize: 14 },
});
