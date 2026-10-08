/**
 * New invoice.
 *
 * Creates a DRAFT. app-api assigns the definitive number on finalise, so the
 * flow is create → review on the detail screen → finalise → send, rather than
 * issuing straight from the form.
 *
 * For a US entity the form asks where the goods or service go (ship-to, with a
 * bill-to that can differ), and each line gets a product tax code instead of a
 * rate. books-api calculates the sales tax per jurisdiction from those; the
 * form previews what it would charge (`POST /sales-tax/calculate`) as the user
 * types, with the engine's warnings, and never calculates tax itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, KeyboardAvoidingView, Platform, Text } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';

import api from '@/services/api';
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
import {
  EMPTY_ADDRESS,
  isUsAddressTaxable,
  toApiAddress,
  usAddressProblems,
  type AddressDraft,
} from '@/lib/us';
import type { TaxPreview } from '@/types/accounting';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { AddressFields, type AddressErrors } from '@/components/address-fields';
import { LineItemsEditor } from '@/components/line-items';
import { TaxBreakdownCard } from '@/components/tax-breakdown';

const PREVIEW_DEBOUNCE_MS = 800;

type PreviewState = 'idle' | 'loading' | 'ready' | 'failed';

export default function NewInvoiceScreen() {
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { isUs, code } = useJurisdiction();
  const { parseDateInput, formatDateInput, datePlaceholder, currency } = useLocaleFormatters();

  const mode = lineItemTaxMode(isUs, 'invoice');
  const defaultTaxRate = defaultTaxRateFor(code);

  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [issueDate, setIssueDate] = useState(() => formatDateInput(today()));
  const [dueDate, setDueDate] = useState(() => formatDateInput(addDays(30)));
  const [items, setItems] = useState<LineItemDraft[]>(() => [
    createEmptyLineItem({ taxRate: defaultTaxRate }),
  ]);
  const [shipTo, setShipTo] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [billSame, setBillSame] = useState(true);
  const [billTo, setBillTo] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{
    contactName?: string;
    items?: string;
    issueDate?: string;
    dueDate?: string;
    shipTo?: AddressErrors;
    billTo?: AddressErrors;
  }>({});

  const [preview, setPreview] = useState<TaxPreview | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const contactIds = useRef(new Map<string, string | null>());

  const dateHint = datePlaceholder;
  const billingAddress = billSame ? shipTo : billTo;

  // US: preview the sales tax the server would charge, once there is something to tax and a place to tax it.
  useEffect(() => {
    if (!isUs) return;
    const issueIso = parseDateInput(issueDate);
    const lines = toLineItemInputs(items, 'code');
    if (lines.length === 0 || !issueIso || !isUsAddressTaxable(shipTo)) {
      setPreview(null);
      setPreviewState('idle');
      return;
    }

    let cancelled = false;
    setPreviewState('loading');
    const timer = setTimeout(async () => {
      try {
        const name = contactName.trim().toLowerCase();
        if (name && !contactIds.current.has(name)) {
          contactIds.current.set(name, await api.findContactId(contactName));
        }
        const result = await api.previewSalesTax({
          kind: 'invoice',
          contactId: (name && contactIds.current.get(name)) || undefined,
          issueDate: issueIso,
          shippingAddress: toApiAddress(shipTo),
          billingAddress: toApiAddress(billingAddress),
          items: lines,
        });
        if (cancelled) return;
        setPreview(result);
        setPreviewState('ready');
      } catch {
        if (!cancelled) setPreviewState('failed');
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isUs, items, shipTo, billingAddress, issueDate, contactName, parseDateInput]);

  const handleSave = useCallback(async () => {
    const name = contactName.trim();
    const usable = validLineItems(items);
    const issueIso = parseDateInput(issueDate);
    const dueIso = parseDateInput(dueDate);

    const nextErrors: typeof errors = {};
    if (!name) nextErrors.contactName = t.invoiceNew.nameError;
    if (usable.length === 0) nextErrors.items = t.invoiceNew.itemsError;
    if (!issueIso) nextErrors.issueDate = format(t.invoiceNew.dateError, { example: dateHint });
    if (!dueIso) nextErrors.dueDate = format(t.invoiceNew.dateError, { example: dateHint });
    if (isUs) {
      // A draft without a state and ZIP can't be finalised, and the app can't edit a draft afterwards.
      const ship = usAddressProblems(shipTo, { requireStateAndZip: true });
      if (Object.keys(ship).length > 0) nextErrors.shipTo = ship;
      if (!billSame) {
        const bill = usAddressProblems(billTo);
        if (Object.keys(bill).length > 0) nextErrors.billTo = bill;
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !issueIso || !dueIso) return;

    setSaving(true);
    try {
      const invoice = await api.createInvoice({
        contactName: name,
        contactEmail: contactEmail.trim() || undefined,
        issueDate: issueIso,
        dueDate: dueIso,
        notes: notes.trim() || undefined,
        reference: reference.trim() || undefined,
        ...(isUs ? { shippingAddress: toApiAddress(shipTo), billingAddress: toApiAddress(billingAddress) } : {}),
        items: toLineItemInputs(items, mode),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success(t.invoiceNew.created);
      router.replace(`/invoice/${invoice.id}` as never);
    } catch (err) {
      toast.error(describeApiError(err, t, t.invoiceNew.createFailed));
    } finally {
      setSaving(false);
    }
  }, [
    contactName,
    contactEmail,
    issueDate,
    dueDate,
    items,
    notes,
    reference,
    shipTo,
    billTo,
    billSame,
    billingAddress,
    isUs,
    mode,
    dateHint,
    parseDateInput,
    router,
    toast,
    t,
    format,
  ]);

  const serverTax = isUs
    ? { taxTotal: preview?.taxTotal ?? 0, total: preview?.total ?? 0, loading: previewState !== 'ready' }
    : null;

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
              placeholder={isUs ? t.examples.companyUs : t.invoiceNew.namePlaceholder}
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

          {isUs ? (
            <>
              <SectionCard title={t.invoiceNew.shipTo}>
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  {t.invoiceNew.shipToHint}
                </Text>
                <AddressFields
                  value={shipTo}
                  onChange={(next) => {
                    setShipTo(next);
                    if (errors.shipTo) setErrors((e) => ({ ...e, shipTo: undefined }));
                  }}
                  errors={errors.shipTo}
                />
                <Switch
                  label={t.invoiceNew.billToSame}
                  value={billSame}
                  onValueChange={setBillSame}
                />
              </SectionCard>
              {billSame ? null : (
                <SectionCard title={t.invoiceNew.billTo}>
                  <AddressFields
                    value={billTo}
                    onChange={(next) => {
                      setBillTo(next);
                      if (errors.billTo) setErrors((e) => ({ ...e, billTo: undefined }));
                    }}
                    errors={errors.billTo}
                  />
                </SectionCard>
              )}
            </>
          ) : null}

          <SectionCard title={t.invoiceNew.dates}>
            <Input
              label={t.invoiceNew.issueDate}
              value={issueDate}
              onChangeText={(text) => {
                setIssueDate(text);
                if (errors.issueDate) setErrors((e) => ({ ...e, issueDate: undefined }));
              }}
              placeholder={isUs ? dateHint : t.invoiceNew.datePlaceholder}
              error={errors.issueDate}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label={t.invoiceNew.dueDate}
              value={dueDate}
              onChangeText={(text) => {
                setDueDate(text);
                if (errors.dueDate) setErrors((e) => ({ ...e, dueDate: undefined }));
              }}
              placeholder={isUs ? dateHint : t.invoiceNew.datePlaceholder}
              error={errors.dueDate}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </SectionCard>

          <LineItemsEditor
            items={items}
            mode={mode}
            defaultTaxRate={defaultTaxRate}
            currency={currency}
            error={errors.items}
            serverTax={serverTax}
            onChange={(next) => {
              setItems(next);
              if (errors.items) setErrors((e) => ({ ...e, items: undefined }));
            }}
          />

          {isUs ? (
            <>
              {previewState === 'idle' ? (
                <Text style={[styles.pending, { color: colors.mutedForeground }]}>
                  {t.salesTax.needsAddress}
                </Text>
              ) : null}
              {previewState === 'loading' ? (
                <Banner variant="info" style={styles.banner}>
                  {t.salesTax.calculating}
                </Banner>
              ) : null}
              {previewState === 'failed' ? (
                <Banner variant="warning" style={styles.banner}>
                  {t.salesTax.previewFailed}
                </Banner>
              ) : null}
              {previewState === 'ready' && preview ? (
                <TaxBreakdownCard
                  rows={preview.taxBreakdown}
                  warnings={preview.warnings}
                  currency={currency}
                  footnote={t.salesTax.estimateNote}
                />
              ) : null}
            </>
          ) : null}

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
  hint: { fontSize: 13, lineHeight: 19, marginBottom: 8 },
  pending: { fontSize: 12, lineHeight: 17, marginHorizontal: 16, marginTop: 10 },
  banner: { marginHorizontal: 12, marginTop: 8 },
  submit: { marginHorizontal: 12, marginTop: 20 },
});
