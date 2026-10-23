/**
 * New bill.
 *
 * Optionally linked to a scanned document via `?documentId=`. After OCR the
 * vendor, supplier invoice number, dates and line items are filled in for
 * review. The receipt stays attached as `sourceDocumentId`.
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';

import api, { receiptFileName } from '@/services/api';
import { today, addDays } from '@/lib/date';
import { useJurisdiction } from '@/hooks/useJurisdiction';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import { defaultTaxRateFor } from '@/lib/jurisdiction';
import {
  createEmptyLineItem,
  lineItemTaxMode,
  toLineItemInputs,
  validLineItems,
  type LineItemDraft,
} from '@/lib/line-items';
import { describeApiError } from '@/lib/sales-tax';
import { EMPTY_ADDRESS, toApiAddress, usAddressProblems, type AddressDraft } from '@/lib/us';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { AddressFields, type AddressErrors } from '@/components/address-fields';
import { LineItemsEditor } from '@/components/line-items';
import { DateField } from '@/components/date-field';
import { FormScrollView } from '@/components/form-scroll';
import { ReceiptPreview } from '@/components/receipt-preview';
import type { BillPrefill } from '@/types/accounting';

function dueFromIssue(issueDate: string): string {
  const [year, month, day] = issueDate.split('-').map(Number);
  if (!year || !month || !day) return addDays(30);
  return addDays(30, new Date(year, month - 1, day));
}

function itemsFromPrefill(prefill: BillPrefill, defaultTaxRate: string): LineItemDraft[] {
  if (!prefill.items.length) return [createEmptyLineItem({ taxRate: defaultTaxRate })];
  return prefill.items.map((item, index) => ({
    ...createEmptyLineItem({ taxRate: defaultTaxRate }),
    key: `ocr_${index}_${item.sortOrder}`,
    description: item.description,
    quantity: item.quantity || '1',
    unitPrice: item.unitPrice === '0' ? '' : item.unitPrice,
    taxRate: item.taxRate ?? defaultTaxRate,
  }));
}

export default function NewBillScreen() {
  const { documentId, receiptUri, receiptType } = useLocalSearchParams<{
    documentId?: string;
    receiptUri?: string;
    receiptType?: string;
  }>();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { isUs, code, labels, terms } = useJurisdiction();
  const { currency } = useLocaleFormatters();

  const mode = lineItemTaxMode(isUs, 'bill');
  const defaultTaxRate = defaultTaxRateFor(code);

  const [contactName, setContactName] = useState('');
  const [billNumber, setBillNumber] = useState('');
  // Calendar days as `YYYY-MM-DD`; the date fields show them in the company's locale.
  const [issueDate, setIssueDate] = useState(() => today());
  const [dueDate, setDueDate] = useState(() => addDays(30));
  const [items, setItems] = useState<LineItemDraft[]>(() => [
    createEmptyLineItem({ taxRate: defaultTaxRate }),
  ]);
  const [deliveredTo, setDeliveredTo] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [deliveredToErrors, setDeliveredToErrors] = useState<AddressErrors>({});
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  // From the scan: the supplier OCR matched (by VAT number, KvK or IBAN, so it beats a lookup
  // by name while the name is still the scanned one) and the receipt's currency.
  const [scanned, setScanned] = useState<{
    contactName: string | null;
    contactId: string | null;
    currency: string | null;
  } | null>(null);
  const [ocrState, setOcrState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    documentId ? 'loading' : 'idle',
  );
  const [errors, setErrors] = useState<{
    contactName?: string;
    items?: string;
    dueDate?: string;
  }>({});

  const accruesUseTax = isUs && items.some((item) => item.accrueUseTax);

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
        if (prefill.items.length > 0) setItems(itemsFromPrefill(prefill, defaultTaxRate));
        setScanned({
          contactName: prefill.contactName,
          contactId: prefill.matchedContactId,
          currency: prefill.currency,
        });
        setOcrState('ready');
      } catch {
        if (!cancelled) setOcrState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, defaultTaxRate]);

  const handleSave = useCallback(async () => {
    const name = contactName.trim();
    const usable = validLineItems(items);
    const nextErrors: typeof errors = {};
    if (!name) nextErrors.contactName = format(t.billNew.nameError, terms);
    if (usable.length === 0) nextErrors.items = t.billNew.itemsError;
    if (dueDate < issueDate) nextErrors.dueDate = t.billNew.dueBeforeIssue;
    setErrors(nextErrors);

    // Use tax is rated for where the goods were delivered; blank means the company address.
    const deliveryProblems = accruesUseTax ? usAddressProblems(deliveredTo) : {};
    setDeliveredToErrors(deliveryProblems);
    if (Object.keys(nextErrors).length > 0 || Object.keys(deliveryProblems).length > 0) {
      return;
    }

    setSaving(true);
    try {
      const sameSupplier = scanned?.contactId && name === scanned.contactName?.trim();
      // A photo scanned offline (or whose upload failed) is stored now, so the bill links it.
      let sourceDocumentId = documentId;
      if (!sourceDocumentId && receiptUri) {
        const mimeType = receiptType || 'image/jpeg';
        const fileName = receiptFileName(mimeType);
        sourceDocumentId = (await api.uploadReceipt({ localUri: receiptUri, mimeType, fileName })) ?? undefined;
      }
      const bill = await api.createBill({
        ...(sameSupplier ? { contactId: scanned.contactId! } : {}),
        contactName: name,
        ...(scanned?.currency ? { currency: scanned.currency } : {}),
        billNumber: billNumber.trim() || undefined,
        issueDate,
        dueDate,
        notes: notes.trim() || undefined,
        reference: reference.trim() || undefined,
        externalReference: reference.trim() || undefined,
        documentId: sourceDocumentId,
        ...(accruesUseTax ? { deliveryAddress: toApiAddress(deliveredTo) } : {}),
        items: toLineItemInputs(items, mode),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success(t.billNew.created);
      router.replace(`/bill/${bill.id}` as never);
    } catch (err) {
      toast.error(describeApiError(err, t, t.billNew.createFailed));
    } finally {
      setSaving(false);
    }
  }, [
    contactName,
    billNumber,
    issueDate,
    dueDate,
    items,
    notes,
    reference,
    documentId,
    receiptUri,
    receiptType,
    scanned,
    deliveredTo,
    accruesUseTax,
    mode,
    router,
    toast,
    t,
    format,
    terms,
  ]);

  return (
    <Screen header={<ScreenHeader title={t.billNew.title} showBack />}>
      <FormScrollView contentContainerStyle={styles.content}>
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

          <ReceiptPreview uri={receiptUri} />

          <SectionCard title={labels.supplier}>
            <Input
              label={t.billNew.name}
              value={contactName}
              onChangeText={(text) => {
                setContactName(text);
                if (errors.contactName) setErrors((e) => ({ ...e, contactName: undefined }));
              }}
              placeholder={format(t.billNew.namePlaceholder, terms)}
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
            <DateField
              label={t.billNew.issueDate}
              value={issueDate}
              onChange={(iso) => {
                setIssueDate(iso);
                if (errors.dueDate) setErrors((e) => ({ ...e, dueDate: undefined }));
              }}
            />
            <DateField
              label={t.billNew.dueDate}
              value={dueDate}
              onChange={(iso) => {
                setDueDate(iso);
                if (errors.dueDate) setErrors((e) => ({ ...e, dueDate: undefined }));
              }}
              error={errors.dueDate}
            />
          </SectionCard>

          <LineItemsEditor
            items={items}
            mode={mode}
            defaultTaxRate={defaultTaxRate}
            currency={currency}
            error={errors.items}
            onChange={(next) => {
              setItems(next);
              if (errors.items) setErrors((e) => ({ ...e, items: undefined }));
            }}
          />

          {accruesUseTax ? (
            <SectionCard title={t.billNew.deliveredTo}>
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                {t.billNew.deliveredToHint}
              </Text>
              <AddressFields
                value={deliveredTo}
                onChange={(next) => {
                  setDeliveredTo(next);
                  setDeliveredToErrors({});
                }}
                errors={deliveredToErrors}
              />
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.billNew.useTaxNote}</Text>
            </SectionCard>
          ) : null}

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
              placeholder={format(t.billNew.referencePlaceholder, terms)}
            />
          </SectionCard>

          <Button
            title={t.billNew.create}
            onPress={handleSave}
            loading={saving}
            fullWidth
            style={styles.submit}
          />
      </FormScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 4 },
  banner: { marginHorizontal: 12, marginBottom: 8 },
  hint: { fontSize: 13, lineHeight: 19, marginBottom: 8 },
  submit: { marginHorizontal: 12, marginTop: 20 },
});
