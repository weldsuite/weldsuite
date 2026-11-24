/**
 * Settings → Offline copy (ADR PASS-010): what state this phone's copy is
 * in, a sync button, and the person's phones that keep a copy, each of which
 * they can remove (its copy is wiped at its next sync). Hidden where the
 * server keeps no copies.
 */

import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from 'react-native';
import { CloudDownload, Smartphone } from 'lucide-react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WeldPassDevice } from '@weldsuite/app-api-client/domains/weldpass-devices';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { Group, GroupRow } from '@/components/Group';
import { useOffline } from '@/contexts/OfflineContext';
import { useWorkspaceKey } from '@/hooks/use-passwords';
import { brandFor } from '@/lib/brand';
import { passErrorMessage } from '@/lib/errors';
import { formatWhen } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { appApi } from '@/services/app-api';

export function OfflineSettings() {
  const { t, format, intlLocale } = useI18n();
  const { colors, theme } = useTheme();
  const offline = useOffline();
  const brand = brandFor(theme);

  if (offline.status === 'off') return null;

  let state: string;
  switch (offline.status) {
    case 'unavailable':
      state = t.settings.offlineUnavailable;
      break;
    case 'locked':
      state = t.settings.offlineLocked;
      break;
    case 'disabled':
      state = t.settings.offlineDisabled;
      break;
    case 'revoked':
      state = t.settings.offlineRevoked;
      break;
    default:
      if (offline.offline && offline.copy) {
        state = format(t.settings.offlineNoConnection, { time: formatWhen(offline.copy.syncedAt, intlLocale) });
      } else if (offline.copy) {
        state = format(t.settings.offlineReady, { time: formatWhen(offline.copy.syncedAt, intlLocale) });
      } else {
        state = t.settings.offlineSyncing;
      }
  }

  let action = null;
  if (offline.status === 'ready') {
    action = offline.syncing ? (
      <ActivityIndicator size="small" color={colors.mutedForeground} />
    ) : (
      <Pressable onPress={() => void offline.sync()} accessibilityRole="button" hitSlop={8} testID="offline-sync">
        <Text style={[styles.link, { color: brand }]}>{t.settings.syncNow}</Text>
      </Pressable>
    );
  } else if (offline.status === 'revoked') {
    action = (
      <Pressable onPress={() => void offline.enableAgain()} accessibilityRole="button" hitSlop={8}>
        <Text style={[styles.link, { color: brand }]}>{t.settings.turnOnAgain}</Text>
      </Pressable>
    );
  }

  return (
    <>
      <Group title={t.settings.offline} footer={t.settings.offlineFooter}>
        <GroupRow
          icon={<CloudDownload size={20} color={brand} />}
          title={t.settings.offline}
          subtitle={state}
          value={action}
          testID="offline-status"
        />
      </Group>
      {offline.status === 'unavailable' ? null : <DeviceList />}
    </>
  );
}

/** The person's own phones with a copy; removing one wipes its copy at its next sync. */
function DeviceList() {
  const { t, format, intlLocale } = useI18n();
  const { colors } = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const workspace = useWorkspaceKey();
  const offline = useOffline();
  const key = ['weldpass', workspace, 'devices'] as const;
  const devices = useQuery({ queryKey: key, queryFn: async () => (await appApi.devices.listDevices()).data });
  const thisDevice = offline.copy?.deviceId ?? null;
  const remove = useMutation({
    mutationFn: (deviceId: string) => appApi.devices.revokeDevice(deviceId),
    onSuccess: async (_data, deviceId) => {
      await queryClient.invalidateQueries({ queryKey: key });
      if (deviceId === thisDevice) await offline.sync();
    },
    onError: (error) => toast.error(passErrorMessage(t, error)),
  });

  const active = (devices.data ?? []).filter((device) => !device.revokedAt);
  if (active.length === 0) return null;

  const confirm = (device: WeldPassDevice) => {
    Alert.alert(format(t.settings.removeDeviceTitle, { name: device.name }), t.settings.removeDeviceMessage, [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.settings.removeDevice, style: 'destructive', onPress: () => remove.mutate(device.id) },
    ]);
  };

  return (
    <Group title={t.settings.devices}>
      {active.map((device) => {
        const synced = device.lastSyncAt
          ? format(t.settings.lastSync, { time: formatWhen(device.lastSyncAt, intlLocale) })
          : t.settings.neverSynced;
        const mine = device.id === thisDevice;
        return (
          <GroupRow
            key={device.id}
            icon={<Smartphone size={20} color={colors.mutedForeground} />}
            title={mine ? `${device.name} · ${t.settings.thisPhone}` : device.name}
            subtitle={synced}
            value={
              <Pressable onPress={() => confirm(device)} accessibilityRole="button" hitSlop={8}>
                <Text style={[styles.link, { color: colors.destructive }]}>{t.settings.removeDevice}</Text>
              </Pressable>
            }
          />
        );
      })}
    </Group>
  );
}

const styles = StyleSheet.create({
  link: { fontSize: 15, fontWeight: '600' },
});
