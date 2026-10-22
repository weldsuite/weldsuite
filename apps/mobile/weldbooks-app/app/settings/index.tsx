/**
 * Settings — company, workspace, appearance and sync status.
 *
 * Company figures come from `/api/accounting-settings`, which is entity-scoped;
 * the workspace row reads the Clerk-backed WorkspaceContext.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import Constants from 'expo-constants';
import { Moon, Sun, LogOut, RefreshCw, ChevronRight, Pencil } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';

import api from '@/services/api';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow } from '@/components/detail';
import { EditCompanySheet } from '@/components/edit-company-sheet';
import { DetailSkeleton } from '@/components/data-states';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import { useJurisdiction, useJurisdictions } from '@/hooks/useJurisdiction';
import { fiscalYearStartLabel, missingInvoiceFields, requiredInvoiceFields } from '@/lib/company';
import { invoiceFieldNames, listInvoiceFields } from '@/lib/company-form';
import { useI18n } from '@/lib/i18n';
import { addressLines } from '@/lib/us';
import type { AppSettings } from '@/types/accounting';

/** Loads the entity-scoped settings, again whenever the active entity changes. */
function useCompanySettings() {
  const { activeEntity } = useAccountingEntity();
  const { t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      setError(null);
      setSettings(await api.getSettings());
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [activeEntity?.id, t]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return { settings, loading, error, refetch: fetchSettings };
}

/** The translated name for a stored code, falling back to the code itself. */
function lookupLabel(labels: Record<string, string>, key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  return labels[key] ?? key;
}

/** The administration name: a switcher row when the user has more than one, a plain row otherwise. */
function AdministrationRow({ name }: Readonly<{ name: string }>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { activeEntity, canSwitch, openSwitcher } = useAccountingEntity();

  if (!canSwitch) return <DetailRow label={t.settings.name} value={name} />;

  return (
    <Pressable
      onPress={openSwitcher}
      accessibilityRole="button"
      accessibilityLabel={format(t.screen.switchAdministration, {
        name: activeEntity?.name ?? '',
      })}
      style={({ pressed }) => [styles.switchRow, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.switchLabel}>
        <View>
          <Text style={[styles.adminLabel, { color: colors.mutedForeground }]}>
            {t.settings.administration}
          </Text>
          <Text style={[styles.adminValue, { color: colors.text }]}>{name}</Text>
        </View>
      </View>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

/** A field the jurisdiction needs on invoices shows as "Not set" while it is empty, instead of vanishing. */
function InvoiceFieldRow({
  label,
  value,
  required,
  notSet,
}: Readonly<{
  label: string;
  value: string | null | undefined;
  required: boolean;
  notSet: ReactNode;
}>) {
  if (!value && !required) return null;
  return <DetailRow label={label} value={value ?? notSet} />;
}

/** Tax ID, registration number and IBAN. */
function IdentifierRows({
  settings,
  requiredFields,
  notSet,
}: Readonly<{
  settings: AppSettings | null;
  requiredFields: ReturnType<typeof requiredInvoiceFields>;
  notSet: ReactNode;
}>) {
  const { activeEntity } = useAccountingEntity();
  const { t } = useI18n();
  const { isUs, labels } = useJurisdiction();
  // The tax ID of the active entity: the EIN for a US company, the VAT number otherwise (the entity is
  // what the edit sheet refreshes; the settings row is the fallback).
  const taxIdValue = (isUs ? activeEntity?.ein : activeEntity?.vatNumber) ?? settings?.vatNumber;

  return (
    <>
      <InvoiceFieldRow
        label={labels.taxId}
        value={taxIdValue}
        required={requiredFields.includes('vatNumber')}
        notSet={notSet}
      />
      <InvoiceFieldRow
        label={labels.registrationId}
        value={activeEntity?.registrationNumber}
        required={requiredFields.includes('registrationNumber')}
        notSet={notSet}
      />
      <InvoiceFieldRow
        label={t.company.iban}
        value={activeEntity?.iban}
        required={requiredFields.includes('iban')}
        notSet={notSet}
      />
    </>
  );
}

/** US only: legal form, tax classification and DBA name. */
function UsEntityRows() {
  const { activeEntity } = useAccountingEntity();
  const { t } = useI18n();
  const { isUs } = useJurisdiction();
  if (!isUs) return null;

  const legalForm = lookupLabel(
    t.entitySetup.entityTypes as Record<string, string>,
    activeEntity?.entityType,
  );
  const classification = lookupLabel(
    t.entitySetup.taxClassifications as Record<string, string>,
    activeEntity?.taxClassification,
  );

  return (
    <>
      {legalForm ? <DetailRow label={t.settings.legalForm} value={legalForm} /> : null}
      {classification ? <DetailRow label={t.settings.taxClassification} value={classification} /> : null}
      {activeEntity?.dba ? <DetailRow label={t.settings.dba} value={activeEntity.dba} /> : null}
    </>
  );
}

function CompanyCard({
  settings,
  error,
  onEdit,
}: Readonly<{ settings: AppSettings | null; error: string | null; onEdit: () => void }>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const { activeEntity } = useAccountingEntity();
  const { code, labels, formatLocale, currency: entityCurrency } = useJurisdiction();
  const { data: loadedJurisdictions } = useJurisdictions();

  const name = activeEntity?.name ?? settings?.entityName ?? t.common.dash;
  const entityAddress = addressLines(activeEntity?.address);
  const requiredFields = requiredInvoiceFields(code, loadedJurisdictions);
  const missingFields = missingInvoiceFields(activeEntity, requiredFields);
  const fieldNames = invoiceFieldNames(t, labels);
  const notSet = <Text style={[styles.notSet, { color: colors.warning }]}>{t.company.notSet}</Text>;

  return (
    <SectionCard title={t.settings.company}>
      <AdministrationRow name={name} />
      <DetailRow
        label={t.settings.jurisdiction}
        value={activeEntity?.jurisdictionCode ?? settings?.jurisdictionCode ?? t.common.dash}
      />
      <DetailRow label={t.settings.baseCurrency} value={settings?.currency ?? entityCurrency} />
      <DetailRow
        label={t.settings.fiscalYearStart}
        value={
          fiscalYearStartLabel(activeEntity?.fiscalYearStart ?? settings?.fiscalYearStart, formatLocale) ??
          t.settings.fiscalYearFallback
        }
      />
      <IdentifierRows settings={settings} requiredFields={requiredFields} notSet={notSet} />
      <UsEntityRows />
      <DetailRow
        label={t.settings.address}
        value={entityAddress.length > 0 ? entityAddress.join('\n') : notSet}
      />
      {missingFields.length > 0 ? (
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          {format(t.settings.missingForInvoices, {
            fields: listInvoiceFields(missingFields, fieldNames, {
              comma: ', ',
              and: t.company.listAnd,
            }),
          })}
        </Text>
      ) : null}
      <Button
        title={t.settings.editCompany}
        variant="outline"
        size="sm"
        leftIcon={<Pencil size={16} color={colors.text} />}
        onPress={onEdit}
        style={styles.editCompany}
      />
      {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
    </SectionCard>
  );
}

function AppearanceCard() {
  const { colors, theme, toggleTheme } = useTheme();
  const { t, language } = useI18n();
  const ThemeIcon = theme === 'dark' ? Moon : Sun;

  return (
    <SectionCard title={t.settings.appearance}>
      <View style={styles.switchRow}>
        <View style={styles.switchLabel}>
          <ThemeIcon size={18} color={colors.mutedForeground} />
          <Text style={[styles.switchText, { color: colors.text }]}>{t.settings.darkMode}</Text>
        </View>
        <Switch value={theme === 'dark'} onValueChange={() => void toggleTheme()} />
      </View>
      <DetailRow label={t.settings.language} value={t.languageNames[language]} />
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.settings.languageHint}</Text>
    </SectionCard>
  );
}

function SyncCard() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { queue, isOnline, isSyncing, syncQueue } = useOfflineQueue();

  return (
    <SectionCard title={t.settings.sync}>
      <DetailRow
        label={t.settings.connection}
        value={isOnline ? t.settings.online : t.settings.offline}
      />
      <DetailRow label={t.settings.queuedItems} value={String(queue.length)} />
      {queue.length > 0 ? (
        <Button
          title={t.settings.syncNow}
          variant="outline"
          size="sm"
          leftIcon={<RefreshCw size={16} color={colors.text} />}
          onPress={() => void syncQueue()}
          loading={isSyncing}
          disabled={!isOnline}
          style={styles.syncButton}
        />
      ) : null}
    </SectionCard>
  );
}

function SignOutConfirm({ visible, onClose }: Readonly<{ visible: boolean; onClose: () => void }>) {
  const { t, plural } = useI18n();
  const { signOut } = useClerkAuth();
  const { queue } = useOfflineQueue();
  const toast = useToast();

  return (
    <ConfirmModal
      visible={visible}
      title={t.settings.signOutTitle}
      message={queue.length > 0 ? plural(queue.length, t.settings.signOutQueued) : undefined}
      confirmText={t.settings.signOut}
      cancelText={t.common.cancel}
      variant="destructive"
      onCancel={onClose}
      onConfirm={async () => {
        onClose();
        try {
          await signOut();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t.settings.signOutFailed);
        }
      }}
    />
  );
}

export default function SettingsScreen() {
  const { colors } = useTheme();
  // useWorkspace() returns the whole context — the workspace itself is on
  // `currentWorkspace`.
  const { currentWorkspace } = useWorkspace();
  const { t } = useI18n();
  const { settings, loading, error, refetch } = useCompanySettings();

  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen header={<ScreenHeader title={t.settings.title} showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <DetailSkeleton />
        ) : (
          <>
            <CompanyCard settings={settings} error={error} onEdit={() => setEditOpen(true)} />

            <SectionCard title={t.settings.workspace}>
              <DetailRow
                label={t.settings.workspace}
                value={currentWorkspace?.name ?? t.common.dash}
              />
            </SectionCard>

            <AppearanceCard />

            <SyncCard />

            <SectionCard title={t.settings.app}>
              <DetailRow label={t.settings.version} value={appVersion} />
              <DetailRow label={t.settings.product} value="WeldBooks" />
            </SectionCard>

            <Button
              title={t.settings.signOut}
              variant="outline"
              leftIcon={<LogOut size={18} color={colors.destructive} />}
              textStyle={{ color: colors.destructive }}
              onPress={() => setConfirmSignOut(true)}
              style={styles.signOut}
            />
          </>
        )}
      </ScrollView>

      <EditCompanySheet visible={editOpen} onClose={() => setEditOpen(false)} onSaved={refetch} />

      <SignOutConfirm visible={confirmSignOut} onClose={() => setConfirmSignOut(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 4 },
  error: { fontSize: 13, marginTop: 8 },
  hint: { fontSize: 12, marginTop: 2, marginBottom: 4 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  switchLabel: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchText: { fontSize: 14, fontWeight: '500' },
  adminLabel: { fontSize: 13 },
  adminValue: { fontSize: 16, fontWeight: '600', marginTop: 2 },
  syncButton: { marginTop: 12, alignSelf: 'flex-start' },
  editCompany: { marginTop: 12, alignSelf: 'flex-start' },
  notSet: { fontSize: 14, fontWeight: '500' },
  signOut: { marginHorizontal: 12, marginTop: 24 },
});
