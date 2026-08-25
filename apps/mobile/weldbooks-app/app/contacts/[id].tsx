/**
 * Contact detail — profile, open balance and the documents issued against it.
 *
 * Balance, invoices and bills each come from their own app-api sub-resource;
 * they're fetched together and degrade independently so one failing section
 * never blanks the screen.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Building2, FileText, Receipt, Trash2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';

import api from '@/services/api';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow, IconTile } from '@/components/detail';
import { RecordRow } from '@/components/record-row';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { InvoiceStatusBadge, BillStatusBadge } from '@/components/status-badge';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import type { Bill, Contact, ContactBalance, Invoice } from '@/types/accounting';

export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();
  const { formatCurrency, formatShortDate } = useLocaleFormatters();

  const ROLE_LABELS: Record<string, string> = {
    customer: t.contacts.customer,
    supplier: t.contacts.supplier,
    both: t.contacts.both,
  };

  const [contact, setContact] = useState<Contact | null>(null);
  const [balance, setBalance] = useState<ContactBalance | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(false);
      // The contact itself gates the screen; the three sub-resources are
      // best-effort so a missing balance doesn't hide the profile.
      const [row, balanceResult, invoiceResult, billResult] = await Promise.all([
        api.getContact(id),
        api.getContactBalance(id).catch(() => null),
        api.getContactInvoices(id).catch(() => [] as Invoice[]),
        api.getContactBills(id).catch(() => [] as Bill[]),
      ]);
      setContact(row);
      setBalance(balanceResult);
      setInvoices(invoiceResult);
      setBills(billResult);
    } catch (err) {
      console.error('Failed to load contact:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const open = useCallback(
    (route: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const header = (
    <ScreenHeader
      title={contact?.name || t.contactDetail.title}
      subtitle={contact ? ROLE_LABELS[contact.type] : undefined}
      showBack
      actions={
        contact ? (
          <IconButton
            icon={<Trash2 size={20} color={colors.destructive} />}
            accessibilityLabel={t.contactDetail.deleteContact}
            onPress={() => setConfirmDelete(true)}
          />
        ) : null
      }
    />
  );

  if (loading) {
    return (
      <Screen header={header}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (error || !contact) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.contactDetail.loadError}
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </Screen>
    );
  }

  const currency = balance?.currency ?? 'EUR';

  return (
    <Screen header={header}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={ACCENTS.contacts}
          />
        }
      >
        <SectionCard>
          <View style={styles.profile}>
            <IconTile icon={Building2} color={ACCENTS.contacts} size={48} />
            <View style={styles.profileText}>
              <Text style={[styles.profileName, { color: colors.text }]} numberOfLines={2}>
                {contact.name}
              </Text>
              <Badge
                variant="secondary"
                size="sm"
                label={ROLE_LABELS[contact.type] ?? contact.type}
                style={styles.profileBadge}
              />
            </View>
          </View>
        </SectionCard>

        {balance ? (
          <SectionCard title={t.contactDetail.balance}>
            <DetailRow
              label={t.contactDetail.receivable}
              value={formatCurrency(balance.receivable, currency)}
              valueColor={balance.receivable > 0 ? colors.warning : undefined}
              strong
            />
            <DetailRow
              label={t.contactDetail.payable}
              value={formatCurrency(balance.payable, currency)}
              valueColor={balance.payable > 0 ? colors.warning : undefined}
              strong
            />
          </SectionCard>
        ) : null}

        {contact.email || contact.phone || contact.vatNumber ? (
          <SectionCard title={t.contactDetail.details}>
            {contact.email ? (
              <DetailRow label={t.contactDetail.email} value={contact.email} />
            ) : null}
            {contact.phone ? (
              <DetailRow label={t.contactDetail.phone} value={contact.phone} />
            ) : null}
            {contact.vatNumber ? (
              <DetailRow label={t.contactDetail.vatNumber} value={contact.vatNumber} />
            ) : null}
            {contact.city ? (
              <DetailRow label={t.contactDetail.city} value={contact.city} />
            ) : null}
          </SectionCard>
        ) : null}

        {invoices.length ? (
          <SectionCard title={t.contactDetail.invoices} padded={false}>
            <View style={styles.related}>
              {invoices.slice(0, 5).map((invoice) => (
                <RecordRow
                  key={invoice.id}
                  leading={<IconTile icon={FileText} color={ACCENTS.vat} size={32} />}
                  title={invoice.invoiceNumber || t.common.draft}
                  subtitle={formatShortDate(invoice.issueDate)}
                  amount={formatCurrency(invoice.total, invoice.currency || currency)}
                  badge={
                    <InvoiceStatusBadge
                      status={invoice.status}
                      dueDate={invoice.dueDate}
                      balanceDue={invoice.balanceDue}
                    />
                  }
                  onPress={() => open(`/invoice/${invoice.id}`)}
                />
              ))}
            </View>
          </SectionCard>
        ) : null}

        {bills.length ? (
          <SectionCard title={t.contactDetail.bills} padded={false}>
            <View style={styles.related}>
              {bills.slice(0, 5).map((bill) => (
                <RecordRow
                  key={bill.id}
                  leading={<IconTile icon={Receipt} color={ACCENTS.profitLoss} size={32} />}
                  title={bill.billNumber || t.common.draft}
                  subtitle={formatShortDate(bill.issueDate)}
                  amount={formatCurrency(bill.total, bill.currency || currency)}
                  badge={
                    <BillStatusBadge
                      status={bill.status}
                      dueDate={bill.dueDate}
                      balanceDue={bill.balanceDue}
                    />
                  }
                  onPress={() => open(`/bill/${bill.id}`)}
                />
              ))}
            </View>
          </SectionCard>
        ) : null}
      </ScrollView>

      <ConfirmModal
        visible={confirmDelete}
        title={t.contactDetail.deleteTitle}
        message={t.contactDetail.deleteMessage}
        confirmText={t.common.delete}
        variant="destructive"
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          setDeleting(true);
          try {
            await api.deleteContact(contact.id);
            toast.success(t.contactDetail.deleted);
            router.back();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.contactDetail.deleteFailed);
          } finally {
            setDeleting(false);
          }
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 4 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  profileText: { flex: 1 },
  profileName: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  profileBadge: { alignSelf: 'flex-start', marginTop: 6 },
  related: { padding: 12, paddingTop: 4, gap: 8 },
});
