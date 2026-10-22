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
import { Building2, FileText, Globe, Mail, Phone, Tag } from 'lucide-react-native';
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
import { api, type CompanyPerson, type CompanyRecord, type DealRecord } from '@/services/api';
import { hideAppSplash } from '@/utils/splash';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { describeError, optionalText, validateCompany, type FormErrors } from '@/lib/validation';

interface CompanyForm {
  name: string;
  industry: string;
  website: string;
  email: string;
  phone: string;
  description: string;
}

type EditableField = keyof CompanyForm;

const EMPTY_FORM: CompanyForm = { name: '', industry: '', website: '', email: '', phone: '', description: '' };

const formFromCompany = (company: CompanyRecord): CompanyForm => ({
  name: company.name,
  industry: company.industry ?? '',
  website: company.website ?? '',
  email: company.email,
  phone: company.phone ?? '',
  description: company.description ?? '',
});

export default function CompanyDetailScreen() {
  const { markInteractive } = useObserve();
  const { id, name, edit } = useLocalSearchParams<{ id: string; name?: string; edit?: string }>();
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();

  const [company, setCompany] = useState<CompanyRecord | null>(null);
  const [people, setPeople] = useState<CompanyPerson[]>([]);
  const [deals, setDeals] = useState<DealRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(edit === 'true');
  const [form, setForm] = useState<CompanyForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors<'name' | 'email'>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [companyRes, peopleRes, dealsRes] = await Promise.all([
      api.getCompany(id),
      api.getCompanyPeople(id),
      api.getCompanyDeals(id),
    ]);
    if (companyRes.success && companyRes.data) {
      setCompany(companyRes.data);
      setForm(formFromCompany(companyRes.data));
    } else {
      toast.error(t.company.loadFailed);
    }
    if (peopleRes.success && peopleRes.data) setPeople(peopleRes.data);
    if (dealsRes.success && dealsRes.data) setDeals(dealsRes.data);
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

  const displayName = company?.name || name || t.company.title;

  const handleChange = (key: EditableField, text: string) => {
    setForm((prev) => ({ ...prev, [key]: text }));
  };

  const handleCancel = () => {
    if (company) setForm(formFromCompany(company));
    setErrors({});
    setIsEditing(false);
  };

  const handleSave = async () => {
    const found = validateCompany({ name: form.name, email: form.email });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    const res = await api.updateCompany(id, {
      name: form.name,
      industry: form.industry,
      website: form.website,
      email: form.email,
      phone: form.phone,
      description: form.description,
    });
    setSaving(false);

    if (res.success && res.data) {
      setCompany(res.data);
      setForm(formFromCompany(res.data));
      setIsEditing(false);
      toast.success(t.company.savedToast);
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.company.saveFailed);
    }
  };

  const handleDelete = () => {
    Alert.alert(t.company.deleteTitle, interpolate(t.company.deleteMessage, { name: displayName }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const res = await api.deleteCompany(id);
            if (res.success) {
              toast.success(t.company.deletedToast);
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
    if (form.phone) {
      void Linking.openURL(`tel:${form.phone}`);
    } else {
      toast.error(t.common.noPhone);
    }
  };

  const handleEmail = () => {
    if (form.email) void Linking.openURL(`mailto:${form.email}`);
  };

  const handleWebsite = () => {
    if (!form.website) return;
    const url = /^https?:\/\//i.test(form.website) ? form.website : `https://${form.website}`;
    void Linking.openURL(url);
  };

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

  if (!company) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={displayName} onBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={[styles.empty, { color: colors.muted }]}>{t.company.loadFailed}</Text>
        </View>
      </View>
    );
  }

  const fields: RecordFieldConfig<EditableField>[] = [
    { key: 'name', label: t.company.name, icon: Building2, placeholder: t.company.namePlaceholder, required: true },
    { key: 'industry', label: t.company.industry, icon: Tag, placeholder: t.company.industryPlaceholder },
    {
      key: 'website',
      label: t.company.website,
      icon: Globe,
      placeholder: t.company.websitePlaceholder,
      inputProps: { keyboardType: 'url', autoCapitalize: 'none', autoCorrect: false },
      viewLink: 'whenFilled',
      onPressView: handleWebsite,
    },
    {
      key: 'email',
      label: t.company.email,
      icon: Mail,
      placeholder: t.company.emailPlaceholder,
      inputProps: { keyboardType: 'email-address', autoCapitalize: 'none', autoCorrect: false },
      viewLink: 'whenFilled',
      onPressView: handleEmail,
    },
    {
      key: 'phone',
      label: t.company.phone,
      icon: Phone,
      placeholder: t.company.phonePlaceholder,
      inputProps: { keyboardType: 'phone-pad' },
      viewLink: 'whenFilled',
      onPressView: handleCall,
    },
    {
      key: 'description',
      label: t.company.description,
      icon: FileText,
      placeholder: t.company.descriptionPlaceholder,
      multiline: true,
      inputProps: { numberOfLines: 4 },
    },
  ];

  const fieldError = (key: EditableField): string | null => {
    if (key === 'name' && errors.name) return describeError(t, errors.name, t.company.name);
    if (key === 'email' && errors.email) return describeError(t, errors.email, t.company.email);
    return null;
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={isEditing ? t.company.editTitle : displayName}
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

      <ScrollView style={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <RecordProfileHeader
          name={displayName}
          subtitle={form.industry}
          isEditing={isEditing}
          onCall={handleCall}
          onEmail={handleEmail}
        />

        <View style={styles.section}>
          <RecordSectionTitle>{isEditing ? t.company.editDetails : t.company.contactInfo}</RecordSectionTitle>
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
          <>
            <View style={styles.section}>
              <RecordSectionTitle>{t.company.people}</RecordSectionTitle>
              {people.length === 0 ? (
                <Text style={[styles.empty, { color: colors.muted }]}>{t.company.noPeople}</Text>
              ) : (
                people.map((person) => (
                  <RecordLinkRow
                    key={person.linkId}
                    title={person.name}
                    subtitle={optionalText(person.role) ?? person.email}
                    badge={person.isPrimary ? t.company.primary : undefined}
                    onPress={() =>
                      router.push({ pathname: '/person/[id]', params: { id: person.personId, name: person.name } })
                    }
                  />
                ))
              )}
            </View>

            <View style={styles.section}>
              <RecordSectionTitle>{t.company.deals}</RecordSectionTitle>
              {deals.length === 0 ? (
                <Text style={[styles.empty, { color: colors.muted }]}>{t.company.noDeals}</Text>
              ) : (
                deals.map((deal) => (
                  <RecordLinkRow
                    key={deal.id}
                    title={deal.name}
                    trailing={deal.value ? formatMoney(deal.value, deal.currency, intlLocale) : undefined}
                  />
                ))
              )}
            </View>

            <View style={styles.section}>
              <RecordSectionTitle>{t.company.info}</RecordSectionTitle>
              <RecordInfoRow label={t.company.status}>{labelFor(t.status, company.status ?? 'active')}</RecordInfoRow>
              <RecordInfoRow label={t.company.created}>
                {new Date(company.createdAt).toLocaleDateString(intlLocale)}
              </RecordInfoRow>
              <RecordInfoRow label={t.company.lastUpdated}>
                {new Date(company.updatedAt).toLocaleDateString(intlLocale)}
              </RecordInfoRow>
            </View>
          </>
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
