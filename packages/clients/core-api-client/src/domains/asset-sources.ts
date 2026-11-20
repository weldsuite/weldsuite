/**
 * Asset sources domain client: `/api/asset-sources` (app-api, core).
 *
 * Device imports into the asset register (Microsoft Intune). Every route needs
 * `weldobjects:manage`. The client secret is write-only: rows carry
 * `hasSecret`, never the secret.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  AssetSource,
  AssetSourceTestResult,
  CreateAssetSourceInput,
  TestAssetSourceInput,
  TestSavedAssetSourceInput,
  UpdateAssetSourceInput,
} from '../schemas/asset-sources';

export function createAssetSourcesApi(api: ClientApi) {
  const base = '/asset-sources';
  const enc = encodeURIComponent;

  return {
    list(): Promise<ListResponse<AssetSource>> {
      return api.get<ListResponse<AssetSource>>(base);
    },
    get(id: string): Promise<DataResponse<AssetSource>> {
      return api.get<DataResponse<AssetSource>>(`${base}/${enc(id)}`);
    },
    create(input: CreateAssetSourceInput): Promise<DataResponse<AssetSource>> {
      return api.post<DataResponse<AssetSource>>(base, input);
    },
    update(id: string, input: UpdateAssetSourceInput): Promise<DataResponse<AssetSource>> {
      return api.patch<DataResponse<AssetSource>>(`${base}/${enc(id)}`, input);
    },
    delete(id: string): Promise<void> {
      return api.delete<void>(`${base}/${enc(id)}`);
    },
    /** Try a connection that is not saved yet. A refusal is still HTTP 200 with `ok: false`. */
    testNew(input: TestAssetSourceInput): Promise<DataResponse<AssetSourceTestResult>> {
      return api.post<DataResponse<AssetSourceTestResult>>(`${base}/test`, input);
    },
    /** Try a saved source, optionally with a replacement secret or config; saves nothing. */
    test(id: string, input: TestSavedAssetSourceInput = {}): Promise<DataResponse<AssetSourceTestResult>> {
      return api.post<DataResponse<AssetSourceTestResult>>(`${base}/${enc(id)}/test`, input);
    },
    /** Start an import now (202); 409 `already_running` while one is under way. */
    sync(id: string): Promise<DataResponse<AssetSource>> {
      return api.post<DataResponse<AssetSource>>(`${base}/${enc(id)}/sync`, {});
    },
  };
}
