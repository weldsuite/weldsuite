/**
 * New bill.
 *
 * Optionally linked to a scanned document via `?documentId=`. After OCR the
 * vendor, supplier invoice number, dates and line items are filled in for
 * review. The receipt stays attached as `sourceDocumentId`.
 */

import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';

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
import type { BillPrefill } from '@/types/accounting';

function dueFromIssue(issueDate: string): string {
  const [year, month, day] = issueDate.split('-').map(Number);
  if (!year || !month || !day) return addDays(30);
  return addDays(30, new Date(year, month - 1, day));
}

function itemsFromPrefill(prefill: BillPrefill): LineItemDraft[] {
  if (!prefill.items.length) return [createEmptyLineItem()];
  return prefill.items.map((item, index) => ({
    key: `ocr_${index}_${item.sortOrder}`,
    description: item.description,
    quantity: item.quantity || '1',
    unitPrice: item.unitPrice === '0' ? '' : item.unitPrice,
    taxRate: item.taxRate ?? '21',
  }));
}

export default function NewBillScreen() {
  const { documentId } = useLocalSearchParams<{ documentId?: string }>();
  const router = useRouter();
  const toast = useToast();

  const [contactName, setContactName] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(30));
  const [items, setItems] = useState<LineItemDraft[]>([createEmptyLineItem()]);
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [ocrState, setOcrState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    documentId ? 'loading' : 'idle',
  );
  const [errors, setErrors] = useState<{ contactName?: string; items?: string }>({});

  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    setOcrState('loading');
    void (async () => {
      try {
        const prefill = await api.getBillFromDocument(documentId);
        if (cancelled) return;
        if (prefill.contactName) setContactName(prefill.contactName);
        if (prefill.externalReference) setReference(prefill.externalReference);
        if (prefill.issueDate) {
          setIssueDate(prefill.issueDate);
          setDueDate(prefill.dueDate || dueFromIssue(prefill.issueDate));
        } else if (prefill.dueDate) {
          setDueDate(prefill.dueDate);
        }
        if (prefill.items.length > 0) setItems(itemsFromPrefill(prefill));
        setOcrState('ready');
      } catch {
        if (!cancelled) setOcrState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const handleSave = useCallback(async () => {
    const name = contactName.trim();
    const usable = validLineItems(items);

    const nextErrors: typeof errors = {};
    if (!name) nextErrors.contactName = 'Enter a vendor name';
    if (usable.length === 0) nextErrors.items = 'Add at least one item with a description and price';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const bill = await api.createBill({
        contactName: name,
        billNumber: billNumber.trim() || undefined,
        issueDate,
        dueDate,
        notes: notes.trim() || undefined,
        reference: reference.trim() || undefined,
        externalReference: reference.trim() || undefined,
        documentId,
        items: usable.map((item, index) => ({
          description: item.description.trim(),
          quantity: parseAmount(item.quantity || '1'),
          unitPrice: parseAmount(item.unitPrice),
          taxRate: parseAmount(item.taxRate || '0'),
          sortOrder: index,
        })),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success('Bill created');
      router.replace(`/bill/${bill.id}` as never);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the bill');
    } finally {
      setSaving(false);
    }
  }, [contactName, billNumber, issueDate, dueDate, items, notes, reference, documentId, router, toast]);

  return (
    <Screen header={<ScreenHeader title="New bill" showBack />}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {ocrState === 'loading' ? (
            <Banner variant="info" style={styles.banner}>
              Filling in fields from the scan…
            </Banner>
          ) : null}
          {ocrState === 'ready' ? (
            <Banner variant="success" style={styles.banner}>
              Prefilled from the scan — check the figures before saving.
            </Banner>
          ) : null}
          {ocrState === 'failed' ? (
            <Banner variant="warning" style={styles.banner}>
              Could not read the receipt. Enter the details — the image is still attached.
            </Banner>
          ) : null}

          <SectionCard title="Vendor">
            <Input
              label="Name"
              value={contactName}
              onChangeText={(text) => {
                setContactName(text);
                if (errors.contactName) setErrors((e) => ({ ...e, contactName: undefined }));
              }}
              placeholder="Supplier name"
              error={errors.contactName}
              helperText={
                errors.contactName ? undefined : 'A matching contact is created if none exists'
              }
              autoCapitalize="words"
            />
            <Input
              label="Bill number"
              value={billNumber}
              onChangeText={setBillNumber}
              placeholder="Auto-generated if empty"
              autoCapitalize="characters"
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
              placeholder="Internal notes"
              numberOfLines={3}
            />
            <Input
              label="Reference"
              value={reference}
              onChangeText={setReference}
              placeholder="Supplier invoice number"
            />
          </SectionCard>

          <Button
            title="Create bill"
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
  banner: { marginHorizontal: 12, marginBottom: 8 },
  submit: { marginHorizontal: 12, marginTop: 20 },
});
