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
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();

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
    if (!name) nextErrors.contactName = t.billNew.nameError;
    if (usable.length === 0) nextErrors.items = t.billNew.itemsError;
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
      toast.success(t.billNew.created);
      router.replace(`/bill/${bill.id}` as never);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.billNew.createFailed);
    } finally {
      setSaving(false);
    }
  }, [contactName, billNumber, issueDate, dueDate, items, notes, reference, documentId, router, toast, t]);

  return (
    <Screen header={<ScreenHeader title={t.billNew.title} showBack />}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {ocrState === 'loading' ? (
            <Banner variant="info" style={styles.banner}>
              {t.billNew.ocrLoading}
            </Banner>
          ) : null}
          {ocrState === 'ready' ? (
            <Banner variant="success" style={styles.banner}>
              {t.billNew.ocrReady}
            </Banner>
          ) : null}
          {ocrState === 'failed' ? (
            <Banner variant="warning" style={styles.banner}>
              {t.billNew.ocrFailed}
            </Banner>
          ) : null}

          <SectionCard title={t.billNew.vendor}>
            <Input
              label={t.billNew.name}
              value={contactName}
              onChangeText={(text) => {
                setContactName(text);
                if (errors.contactName) setErrors((e) => ({ ...e, contactName: undefined }));
              }}
              placeholder={t.billNew.namePlaceholder}
              error={errors.contactName}
              helperText={errors.contactName ? undefined : t.billNew.nameHint}
              autoCapitalize="words"
            />
            <Input
              label={t.billNew.billNumber}
              value={billNumber}
              onChangeText={setBillNumber}
              placeholder={t.billNew.billNumberPlaceholder}
              autoCapitalize="characters"
              autoCorrect={false}
            />
          </SectionCard>

          <SectionCard title={t.billNew.dates}>
            <Input
              label={t.billNew.issueDate}
              value={issueDate}
              onChangeText={setIssueDate}
              placeholder={t.billNew.datePlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label={t.billNew.dueDate}
              value={dueDate}
              onChangeText={setDueDate}
              placeholder={t.billNew.datePlaceholder}
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

          <SectionCard title={t.billNew.extras}>
            <Textarea
              label={t.billNew.notes}
              value={notes}
              onChangeText={setNotes}
              placeholder={t.billNew.notesPlaceholder}
              numberOfLines={3}
            />
            <Input
              label={t.billNew.reference}
              value={reference}
              onChangeText={setReference}
              placeholder={t.billNew.referencePlaceholder}
            />
          </SectionCard>

          <Button
            title={t.billNew.create}
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
