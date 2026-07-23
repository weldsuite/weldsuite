/**
 * Storage upload API factory (app-api).
 *
 * Only covers steps 1 and 3 of the 3-step upload flow — the raw R2 PUT goes
 * to the URL returned by `generateUploadUrl` and is fired directly with
 * XMLHttpRequest in `apps/web/platform/hooks/use-file-upload.ts` so the browser
 * can report progress events. That URL is token-authenticated, not Clerk —
 * intentionally not routed through this typed client.
 */

import type { ClientApi } from '../types';
import type {
  GenerateUploadUrlInput,
  GenerateUploadUrlResponse,
  ConfirmUploadInput,
  ConfirmUploadResponse,
} from '../schemas/storage';

export function createStorageApi(api: ClientApi) {
  return {
    generateUploadUrl(input: GenerateUploadUrlInput): Promise<GenerateUploadUrlResponse> {
      return api.post<GenerateUploadUrlResponse>('/storage/generate-upload-url', input);
    },
    confirmUpload(input: ConfirmUploadInput): Promise<ConfirmUploadResponse> {
      return api.post<ConfirmUploadResponse>('/storage/confirm-upload', input);
    },
  };
}
