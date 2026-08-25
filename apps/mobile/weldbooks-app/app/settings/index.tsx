/**
 * Settings — company, workspace, appearance and sync status.
 *
 * Company figures come from `/api/accounting-settings`, which is entity-scoped;
 * the workspace row reads the Clerk-backed WorkspaceContext.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import Constants from 'expo-constants';
import { Moon, Sun, LogOut, RefreshCw, ChevronRight } from 'lucide-react-native';

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
import { DetailSkeleton } from '@/components/data-states';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
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

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setError(null);
      setSettings(await api.getSettings());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [activeEntity?.id]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen header={<ScreenHeader title="Settings" showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <DetailSkeleton />
        ) : (
          <>
            <SectionCard title="Company">
              {canSwitch ? (
                <Pressable
                  onPress={openSwitcher}
                  accessibilityRole="button"
                  accessibilityLabel={`Switch administration, currently ${activeEntity?.name ?? 'unknown'}`}
                  style={({ pressed }) => [styles.switchRow, pressed && { opacity: 0.7 }]}
                >
                  <View style={styles.switchLabel}>
                    <View>
                      <Text style={[styles.adminLabel, { color: colors.mutedForeground }]}>
                        Administration
                      </Text>
                      <Text style={[styles.adminValue, { color: colors.text }]}>
                        {activeEntity?.name ?? settings?.entityName ?? '—'}
                      </Text>
                    </View>
                  </View>
                  <ChevronRight size={18} color={colors.mutedForeground} />
                </Pressable>
              ) : (
                <DetailRow label="Name" value={activeEntity?.name ?? settings?.entityName ?? '—'} />
              )}
              <DetailRow
                label="Jurisdiction"
                value={activeEntity?.jurisdictionCode ?? settings?.jurisdictionCode ?? '—'}
              />
              <DetailRow label="Base currency" value={settings?.currency ?? 'EUR'} />
              <DetailRow label="Fiscal year start" value={settings?.fiscalYearStart ?? '1 January'} />
              {settings?.vatNumber ? (
                <DetailRow label="VAT number" value={settings.vatNumber} />
              ) : null}
              {error ? (
                <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
              ) : null}
            </SectionCard>

            <SectionCard title="Workspace">
              <DetailRow label="Workspace" value={currentWorkspace?.name ?? '—'} />
            </SectionCard>

            <SectionCard title="Appearance">
              <View style={styles.switchRow}>
                <View style={styles.switchLabel}>
                  {theme === 'dark' ? (
                    <Moon size={18} color={colors.mutedForeground} />
                  ) : (
                    <Sun size={18} color={colors.mutedForeground} />
                  )}
                  <Text style={[styles.switchText, { color: colors.text }]}>Dark mode</Text>
                </View>
                <Switch value={theme === 'dark'} onValueChange={() => void toggleTheme()} />
              </View>
            </SectionCard>

            <SectionCard title="Sync">
              <DetailRow label="Connection" value={isOnline ? 'Online' : 'Offline'} />
              <DetailRow label="Queued items" value={String(queue.length)} />
              {queue.length > 0 ? (
                <Button
                  title="Sync now"
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

            <SectionCard title="App">
              <DetailRow label="Version" value={appVersion} />
              <DetailRow label="Product" value="WeldBooks" />
            </SectionCard>

            <Button
              title="Sign out"
              variant="outline"
              leftIcon={<LogOut size={18} color={colors.destructive} />}
              textStyle={{ color: colors.destructive }}
              onPress={() => setConfirmSignOut(true)}
              style={styles.signOut}
            />
          </>
        )}
      </ScrollView>

      <ConfirmModal
        visible={confirmSignOut}
        title="Sign out?"
        message={
          queue.length > 0
            ? `${queue.length} unsynced item${queue.length === 1 ? '' : 's'} will stay on this device.`
            : undefined
        }
        confirmText="Sign out"
        variant="destructive"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={async () => {
          setConfirmSignOut(false);
          try {
            await signOut();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not sign out');
          }
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 4 },
  error: { fontSize: 13, marginTop: 8 },
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
  signOut: { marginHorizontal: 12, marginTop: 24 },
});
