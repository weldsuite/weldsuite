/**
 * WeldPass devices and the offline copy (ADR PASS-010):
 * `/api/weldpass/devices` and `/api/weldpass/settings`. Rust backend only.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  DeviceEventAction,
  RegisterDeviceInput,
  WeldPassDevice,
  WeldPassSettings,
  WeldPassSyncResult,
} from '../schemas/weldpass-devices';

export type {
  DeviceEventAction,
  RegisterDeviceInput,
  WeldPassDevice,
  WeldPassDevicePlatform,
  WeldPassSettings,
  WeldPassSyncedItem,
  WeldPassSyncedVault,
  WeldPassSyncResult,
} from '../schemas/weldpass-devices';

const base = '/weldpass';

export interface WeldPassDeviceEvent {
  vaultId: string;
  itemId: string;
  action: DeviceEventAction;
  at: string;
}

export function createWeldPassDevicesApi(api: ClientApi) {
  return {
    /** Register this device; its id names it in every sync. */
    registerDevice(body: RegisterDeviceInput): Promise<DataResponse<WeldPassDevice>> {
      return api.post(`${base}/devices`, body);
    },

    /**
     * The caller's devices, newest first. `all: true` lists every device in
     * the workspace, with its owner (`passwords:manage`).
     */
    listDevices(params: { all?: boolean } = {}): Promise<DataResponse<WeldPassDevice[]>> {
      return api.get(`${base}/devices${buildQueryString(params.all ? { all: 'true' } : {})}`);
    },

    /** Revoke a device: its copy is wiped at its next sync. The owner, or `passwords:manage`. */
    revokeDevice(deviceId: string): Promise<void> {
      return api.delete(`${base}/devices/${deviceId}`);
    },

    /** Items changed since each vault's cursor, deletions, and vaults to drop. */
    sync(deviceId: string, cursors: Record<string, string>): Promise<DataResponse<WeldPassSyncResult>> {
      return api.post(`${base}/devices/${deviceId}/sync`, { cursors });
    },

    /** What the device did with its copy (reveals, copies, autofills), into the vaults' trails. */
    uploadEvents(deviceId: string, events: WeldPassDeviceEvent[]): Promise<DataResponse<{ recorded: number }>> {
      return api.post(`${base}/devices/${deviceId}/events`, { events });
    },

    getSettings(): Promise<DataResponse<WeldPassSettings>> {
      return api.get(`${base}/settings`);
    },

    /** `passwords:manage`. Switching offline copies off wipes every device at its next sync. */
    updateSettings(body: WeldPassSettings): Promise<DataResponse<WeldPassSettings>> {
      return api.patch(`${base}/settings`, body);
    },
  };
}

export type WeldPassDevicesApi = ReturnType<typeof createWeldPassDevicesApi>;
