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
    if (!name) nextErrors.contactName = 'Enter a customer name';
    if (usable.length === 0) nextErrors.items = 'Add at least one item with a description and price';
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
      toast.success('Draft invoice created');
      router.replace(`/invoice/${invoice.id}` as never);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the invoice');
    } finally {
      setSaving(false);
    }
  }, [contactName, contactEmail, issueDate, dueDate, items, notes, reference, router, toast]);

  return (
    <Screen header={<ScreenHeader title="New invoice" showBack />}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <SectionCard title="Customer">
            <Input
              label="Name"
              value={contactName}
              onChangeText={(text) => {
                setContactName(text);
                if (errors.contactName) setErrors((e) => ({ ...e, contactName: undefined }));
              }}
              placeholder="Acme B.V."
              error={errors.contactName}
              helperText={
                errors.contactName ? undefined : 'A matching contact is created if none exists'
              }
              autoCapitalize="words"
            />
            <Input
              label="Email"
              value={contactEmail}
              onChangeText={setContactEmail}
              placeholder="billing@acme.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </SectionCard>

          <SectionCard title="Dates">
            <Input
              label="Issue date"
              value={issueDate}
              onChangeText={setIssueDate}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label="Due date"
              value={dueDate}
              onChangeText={setDueDate}
              placeholder="YYYY-MM-DD"
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

          <SectionCard title="Extras">
            <Textarea
              label="Notes"
              value={notes}
              onChangeText={setNotes}
              placeholder="Notes shown to the customer"
              numberOfLines={3}
            />
            <Input
              label="Reference"
              value={reference}
              onChangeText={setReference}
              placeholder="PO number or reference"
            />
          </SectionCard>

          <Button
            title="Create draft"
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
