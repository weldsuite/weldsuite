/**
 * WeldPass offline copy hooks (ADR PASS-010): the workspace switch and the
 * registered phones. The routes are Rust only, so every query stays idle on
 * Global (`weldpass-offline` is not available there) and never requests a
 * route that does not exist.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';

export const weldpassDeviceKeys = {
  all: ['weldpass', 'devices'] as const,
  list: (all: boolean) => [...weldpassDeviceKeys.all, 'list', all] as const,
  settings: () => ['weldpass', 'settings'] as const,
};

/** The caller's devices, or with `all` every device in the workspace (`passwords:manage`). */
export function useWeldPassDevices(all: boolean) {
  const { weldpassDevices } = useAppApi();
  return useQuery({
    queryKey: weldpassDeviceKeys.list(all),
    queryFn: () => weldpassDevices.listDevices({ all }),
    select: (res) => res.data,
    enabled: isFeatureAvailable('weldpass-offline'),
  });
}

/** Revoking wipes the phone's copy the next time it connects. */
export function useRevokeWeldPassDevice() {
  const { weldpassDevices } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => weldpassDevices.revokeDevice(deviceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassDeviceKeys.all });
    },
  });
}

export function useWeldPassSettings() {
  const { weldpassDevices } = useAppApi();
  return useQuery({
    queryKey: weldpassDeviceKeys.settings(),
    queryFn: () => weldpassDevices.getSettings(),
    select: (res) => res.data,
    enabled: isFeatureAvailable('weldpass-offline'),
  });
}

/** `passwords:manage`. Switching offline copies off wipes every phone at its next sync. */
export function useUpdateWeldPassSettings() {
  const { weldpassDevices } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (offlineCopies: boolean) => weldpassDevices.updateSettings({ offlineCopies }),
    onSuccess: (res) => {
      qc.setQueryData(weldpassDeviceKeys.settings(), res);
    },
  });
}
