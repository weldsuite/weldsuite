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
import { StyleSheet, Text } from 'react-native';
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
import { DateField } from '@/components/date-field';
import { FormScrollView } from '@/components/form-scroll';
import { TaxBreakdownCard } from '@/components/tax-breakdown';

const PREVIEW_DEBOUNCE_MS = 800;

type PreviewState = 'idle' | 'loading' | 'ready' | 'failed';

type FormErrors = {
  contactName?: string;
  items?: string;
  dueDate?: string;
  shipTo?: AddressErrors;
  billTo?: AddressErrors;
};

type Strings = ReturnType<typeof useI18n>['t'];

interface FormValues {
  contactName: string;
  items: LineItemDraft[];
  issueDate: string;
  dueDate: string;
  shipTo: AddressDraft;
  billTo: AddressDraft;
  billSame: boolean;
}

/** US only: a draft without a state and ZIP can't be finalised, and the app can't edit a draft afterwards. */
function usAddressErrors(values: FormValues): Pick<FormErrors, 'shipTo' | 'billTo'> {
  const errors: Pick<FormErrors, 'shipTo' | 'billTo'> = {};
  const ship = usAddressProblems(values.shipTo, { requireStateAndZip: true });
  if (Object.keys(ship).length > 0) errors.shipTo = ship;
  if (!values.billSame) {
    const bill = usAddressProblems(values.billTo);
    if (Object.keys(bill).length > 0) errors.billTo = bill;
  }
  return errors;
}

function validateInvoiceForm(values: FormValues, isUs: boolean, t: Strings): FormErrors {
  const errors: FormErrors = isUs ? usAddressErrors(values) : {};
  if (!values.contactName.trim()) errors.contactName = t.invoiceNew.nameError;
  if (validLineItems(values.items).length === 0) errors.items = t.invoiceNew.itemsError;
  if (values.dueDate < values.issueDate) errors.dueDate = t.invoiceNew.dueBeforeIssue;
  return errors;
}

interface PreviewInput {
  isUs: boolean;
  items: LineItemDraft[];
  shipTo: AddressDraft;
  billingAddress: AddressDraft;
  issueDate: string;
  contactName: string;
}

/** US: preview the sales tax the server would charge, once there is something to tax and a place to tax it. */
function useSalesTaxPreview({
  isUs,
  items,
  shipTo,
  billingAddress,
  issueDate,
  contactName,
}: PreviewInput) {
  const [preview, setPreview] = useState<TaxPreview | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const contactIds = useRef(new Map<string, string | null>());

  useEffect(() => {
    if (!isUs) return;
    const lines = toLineItemInputs(items, 'code');
    if (lines.length === 0 || !issueDate || !isUsAddressTaxable(shipTo)) {
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
          issueDate,
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
  }, [isUs, items, shipTo, billingAddress, issueDate, contactName]);

  return { preview, previewState };
}

/** What the sales tax preview is doing: waiting for an address, calculating, failed, or the breakdown. */
function TaxPreviewSection({
  preview,
  previewState,
}: Readonly<{ preview: TaxPreview | null; previewState: PreviewState }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { currency } = useLocaleFormatters();

  switch (previewState) {
    case 'idle':
      return (
        <Text style={[styles.pending, { color: colors.mutedForeground }]}>{t.salesTax.needsAddress}</Text>
      );
    case 'loading':
      return (
        <Banner variant="info" style={styles.banner}>
          {t.salesTax.calculating}
        </Banner>
      );
    case 'failed':
      return (
        <Banner variant="warning" style={styles.banner}>
          {t.salesTax.previewFailed}
        </Banner>
      );
    default:
      return preview ? (
        <TaxBreakdownCard
          rows={preview.taxBreakdown}
          warnings={preview.warnings}
          currency={currency}
          footnote={t.salesTax.estimateNote}
        />
      ) : null;
  }
}

/** US: where the goods go, and a bill-to that can differ. */
function AddressSections({
  shipTo,
  setShipTo,
  billTo,
  setBillTo,
  billSame,
  setBillSame,
  errors,
  clearError,
}: Readonly<{
  shipTo: AddressDraft;
  setShipTo: (next: AddressDraft) => void;
  billTo: AddressDraft;
  setBillTo: (next: AddressDraft) => void;
  billSame: boolean;
  setBillSame: (same: boolean) => void;
  errors: FormErrors;
  clearError: (field: 'shipTo' | 'billTo') => void;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();

  return (
    <>
      <SectionCard title={t.invoiceNew.shipTo}>
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.invoiceNew.shipToHint}</Text>
        <AddressFields
          value={shipTo}
          onChange={(next) => {
            setShipTo(next);
            clearError('shipTo');
          }}
          errors={errors.shipTo}
        />
        <Switch label={t.invoiceNew.billToSame} value={billSame} onValueChange={setBillSame} />
      </SectionCard>
      {billSame ? null : (
        <SectionCard title={t.invoiceNew.billTo}>
          <AddressFields
            value={billTo}
            onChange={(next) => {
              setBillTo(next);
              clearError('billTo');
            }}
            errors={errors.billTo}
          />
        </SectionCard>
      )}
    </>
  );
}

export default function NewInvoiceScreen() {
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();
  const { isUs, code } = useJurisdiction();
  const { currency } = useLocaleFormatters();

  const mode = lineItemTaxMode(isUs, 'invoice');
  const defaultTaxRate = defaultTaxRateFor(code);

  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  // Calendar days as `YYYY-MM-DD`; the date fields show them in the company's locale.
  const [issueDate, setIssueDate] = useState(() => today());
  const [dueDate, setDueDate] = useState(() => addDays(30));
  const [items, setItems] = useState<LineItemDraft[]>(() => [
    createEmptyLineItem({ taxRate: defaultTaxRate }),
  ]);
  const [shipTo, setShipTo] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [billSame, setBillSame] = useState(true);
  const [billTo, setBillTo] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  const billingAddress = billSame ? shipTo : billTo;
  const { preview, previewState } = useSalesTaxPreview({
    isUs,
    items,
    shipTo,
    billingAddress,
    issueDate,
    contactName,
  });
  const clearError = (field: keyof FormErrors) => {
    setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  };

  const handleSave = useCallback(async () => {
    const name = contactName.trim();
    const nextErrors = validateInvoiceForm(
      { contactName, items, issueDate, dueDate, shipTo, billTo, billSame },
      isUs,
      t,
    );
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
    router,
    toast,
    t,
  ]);

  const serverTax = isUs
    ? { taxTotal: preview?.taxTotal ?? 0, total: preview?.total ?? 0, loading: previewState !== 'ready' }
    : null;

  return (
    <Screen header={<ScreenHeader title={t.invoiceNew.title} showBack />}>
      <FormScrollView contentContainerStyle={styles.content}>
          <SectionCard title={t.invoiceNew.customer}>
            <Input
              label={t.invoiceNew.name}
              value={contactName}
              onChangeText={(text) => {
                setContactName(text);
                clearError('contactName');
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
            <AddressSections
              shipTo={shipTo}
              setShipTo={setShipTo}
              billTo={billTo}
              setBillTo={setBillTo}
              billSame={billSame}
              setBillSame={setBillSame}
              errors={errors}
              clearError={clearError}
            />
          ) : null}

          <SectionCard title={t.invoiceNew.dates}>
            <DateField
              label={t.invoiceNew.issueDate}
              value={issueDate}
              onChange={(iso) => {
                setIssueDate(iso);
                clearError('dueDate');
              }}
              testID="invoice-issue-date"
            />
            <DateField
              label={t.invoiceNew.dueDate}
              value={dueDate}
              onChange={(iso) => {
                setDueDate(iso);
                clearError('dueDate');
              }}
              error={errors.dueDate}
              testID="invoice-due-date"
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
              clearError('items');
            }}
          />

          {isUs ? <TaxPreviewSection preview={preview} previewState={previewState} /> : null}

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
      </FormScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 4 },
  hint: { fontSize: 13, lineHeight: 19, marginBottom: 8 },
  pending: { fontSize: 12, lineHeight: 17, marginHorizontal: 16, marginTop: 10 },
  banner: { marginHorizontal: 12, marginTop: 8 },
  submit: { marginHorizontal: 12, marginTop: 20 },
});
