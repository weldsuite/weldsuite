/**
 * New invoice.
 *
 * Creates a DRAFT. app-api assigns the definitive number on finalise, so the
 * flow is create → review on the detail screen → finalise → send, rather than
 * issuing straight from the form.
 */

import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { Button } from '@weldsuite/mobile-ui/components/Button';

import api from '@/services/api';
import { parseAmount } from '@/lib/currency';
import { today, addDays } from '@/lib/date';
import { useI18n } from '@/lib/i18n';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import {
  LineItemsEditor,
  createEmptyLineItem,
  validLineItems,
  type LineItemDraft,
} from '@/components/line-items';

export default function NewInvoiceScreen() {
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();

  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(30));
  const [items, setItems] = useState<LineItemDraft[]>([createEmptyLineItem()]);
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ contactName?: string; items?: string }>({});

  const handleSave = useCallback(async () => {
    const name = contactName.trim();
    const usable = validLineItems(items);

    const nextErrors: typeof errors = {};
    if (!name) nextErrors.contactName = t.invoiceNew.nameError;
    if (usable.length === 0) nextErrors.items = t.invoiceNew.itemsError;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const invoice = await api.createInvoice({
        contactName: name,
        contactEmail: contactEmail.trim() || undefined,
        issueDate,
        dueDate,
        notes: notes.trim() || undefined,
        reference: reference.trim() || undefined,
        items: usable.map((item, index) => ({
          description: item.description.trim(),
          quantity: parseAmount(item.quantity || '1'),
          unitPrice: parseAmount(item.unitPrice),
          taxRate: parseAmount(item.taxRate || '0'),
          sortOrder: index,
        })),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success(t.invoiceNew.created);
      router.replace(`/invoice/${invoice.id}` as never);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.invoiceNew.createFailed);
    } finally {
      setSaving(false);
    }
  }, [contactName, contactEmail, issueDate, dueDate, items, notes, reference, router, toast, t]);

  return (
    <Screen header={<ScreenHeader title={t.invoiceNew.title} showBack />}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <SectionCard title={t.invoiceNew.customer}>
            <Input
              label={t.invoiceNew.name}
              value={contactName}
              onChangeText={(text) => {
                setContactName(text);
                if (errors.contactName) setErrors((e) => ({ ...e, contactName: undefined }));
              }}
              placeholder={t.invoiceNew.namePlaceholder}
              error={errors.contactName}
              helperText={errors.contactName ? undefined : t.invoiceNew.nameHint}
              autoCapitalize="words"
            />
            <Input
              label={t.invoiceNew.email}
              value={contactEmail}
              onChangeText={setContactEmail}
              placeholder={t.invoiceNew.emailPlaceholder}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </SectionCard>

          <SectionCard title={t.invoiceNew.dates}>
            <Input
              label={t.invoiceNew.issueDate}
              value={issueDate}
              onChangeText={setIssueDate}
              placeholder={t.invoiceNew.datePlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label={t.invoiceNew.dueDate}
              value={dueDate}
              onChangeText={setDueDate}
              placeholder={t.invoiceNew.datePlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </SectionCard>

          <LineItemsEditor
            items={items}
            error={errors.items}
            onChange={(next) => {
              setItems(next);
              if (errors.items) setErrors((e) => ({ ...e, items: undefined }));
            }}
          />

          <SectionCard title={t.invoiceNew.extras}>
            <Textarea
              label={t.invoiceNew.notes}
              value={notes}
              onChangeText={setNotes}
              placeholder={t.invoiceNew.notesPlaceholder}
              numberOfLines={3}
            />
            <Input
              label={t.invoiceNew.reference}
              value={reference}
              onChangeText={setReference}
              placeholder={t.invoiceNew.referencePlaceholder}
            />
          </SectionCard>

          <Button
            title={t.invoiceNew.createDraft}
            onPress={handleSave}
            loading={saving}
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
