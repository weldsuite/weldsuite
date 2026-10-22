/**
 * Settings — company, workspace, appearance and sync status.
 *
 * Company figures come from `/api/accounting-settings`, which is entity-scoped;
 * the workspace row reads the Clerk-backed WorkspaceContext.
 */

import { useCallback, useEffect, useState } from 'react';
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

export default function SettingsScreen() {
  const { colors, theme, toggleTheme } = useTheme();
  // useWorkspace() returns the whole context — the workspace itself is on
  // `currentWorkspace`.
  const { currentWorkspace } = useWorkspace();
  const { signOut } = useClerkAuth();
  const { activeEntity, canSwitch, openSwitcher } = useAccountingEntity();
  const { queue, isOnline, isSyncing, syncQueue } = useOfflineQueue();
  const toast = useToast();
  const { t, format, plural, language } = useI18n();
  const { isUs, code, labels, formatLocale, currency: entityCurrency } = useJurisdiction();
  const { data: loadedJurisdictions } = useJurisdictions();

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

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

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';
  // The tax ID of the active entity: the EIN for a US company (settings keep it in the VAT slot too).
  const taxIdValue = (isUs ? activeEntity?.ein : undefined) ?? settings?.vatNumber;
  const legalForm = activeEntity?.entityType
    ? ((t.entitySetup.entityTypes as Record<string, string>)[activeEntity.entityType] ?? activeEntity.entityType)
    : undefined;
  const classification = activeEntity?.taxClassification
    ? ((t.entitySetup.taxClassifications as Record<string, string>)[activeEntity.taxClassification] ??
      activeEntity.taxClassification)
    : undefined;
  const entityAddress = addressLines(activeEntity?.address);
  const requiredFields = requiredInvoiceFields(code, loadedJurisdictions);
  const missingFields = missingInvoiceFields(activeEntity, requiredFields);
  const fieldNames = invoiceFieldNames(t, labels);
  // A field the jurisdiction needs on invoices shows as "Not set" while it is empty, instead of vanishing.
  const notSet = (
    <Text style={[styles.notSet, { color: colors.warning }]}>{t.company.notSet}</Text>
  );

  return (
    <Screen header={<ScreenHeader title={t.settings.title} showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <DetailSkeleton />
        ) : (
          <>
            <SectionCard title={t.settings.company}>
              {canSwitch ? (
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
                      <Text style={[styles.adminValue, { color: colors.text }]}>
                        {activeEntity?.name ?? settings?.entityName ?? t.common.dash}
                      </Text>
                    </View>
                  </View>
                  <ChevronRight size={18} color={colors.mutedForeground} />
                </Pressable>
              ) : (
                <DetailRow
                  label={t.settings.name}
                  value={activeEntity?.name ?? settings?.entityName ?? t.common.dash}
                />
              )}
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
              {taxIdValue || requiredFields.includes('vatNumber') ? (
                <DetailRow label={labels.taxId} value={taxIdValue ?? notSet} />
              ) : null}
              {activeEntity?.registrationNumber || requiredFields.includes('registrationNumber') ? (
                <DetailRow
                  label={labels.registrationId}
                  value={activeEntity?.registrationNumber ?? notSet}
                />
              ) : null}
              {activeEntity?.iban || requiredFields.includes('iban') ? (
                <DetailRow label={t.company.iban} value={activeEntity?.iban ?? notSet} />
              ) : null}
              {isUs && legalForm ? <DetailRow label={t.settings.legalForm} value={legalForm} /> : null}
              {isUs && classification ? (
                <DetailRow label={t.settings.taxClassification} value={classification} />
              ) : null}
              {isUs && activeEntity?.dba ? <DetailRow label={t.settings.dba} value={activeEntity.dba} /> : null}
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
                onPress={() => setEditOpen(true)}
                style={styles.editCompany}
              />
              {error ? (
                <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
              ) : null}
            </SectionCard>

            <SectionCard title={t.settings.workspace}>
              <DetailRow
                label={t.settings.workspace}
                value={currentWorkspace?.name ?? t.common.dash}
              />
            </SectionCard>

            <SectionCard title={t.settings.appearance}>
              <View style={styles.switchRow}>
                <View style={styles.switchLabel}>
                  {theme === 'dark' ? (
                    <Moon size={18} color={colors.mutedForeground} />
                  ) : (
                    <Sun size={18} color={colors.mutedForeground} />
                  )}
                  <Text style={[styles.switchText, { color: colors.text }]}>
                    {t.settings.darkMode}
                  </Text>
                </View>
                <Switch value={theme === 'dark'} onValueChange={() => void toggleTheme()} />
              </View>
              <DetailRow
                label={t.settings.language}
                value={t.languageNames[language]}
              />
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                {t.settings.languageHint}
              </Text>
            </SectionCard>

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

      <EditCompanySheet visible={editOpen} onClose={() => setEditOpen(false)} />

      <ConfirmModal
        visible={confirmSignOut}
        title={t.settings.signOutTitle}
        message={
          queue.length > 0 ? plural(queue.length, t.settings.signOutQueued) : undefined
        }
        confirmText={t.settings.signOut}
        cancelText={t.common.cancel}
        variant="destructive"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={async () => {
          setConfirmSignOut(false);
          try {
            await signOut();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.settings.signOutFailed);
          }
        }}
      />
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
