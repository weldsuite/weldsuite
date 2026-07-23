/**
 * Storage upload schemas (Zod v3) — powers /api/storage/*.
 *
 * 3-step worker-proxied upload flow:
 *   1. POST /generate-upload-url  -> { uploadUrl, uploadToken, fileKey }
 *   2. PUT  {uploadUrl}            -> raw body, returns ETag (token-authenticated, not Clerk)
 *   3. POST /confirm-upload        -> { file }
 */

import { z } from 'zod';

export const generateUploadUrlSchema = z.object({
  fileName: z.string().min(1),
  contentType: z.string().min(1),
  fileSize: z.number().int().min(0),
  folder: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().nullish(),
  isPublic: z.boolean().optional().default(false),
});

export const confirmUploadSchema = z.object({
  uploadToken: z.string().min(1),
  fileKey: z.string().min(1),
  etag: z.string().optional(),
});

export type GenerateUploadUrlInput = z.infer<typeof generateUploadUrlSchema>;
export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;

export interface GenerateUploadUrlResponse {
  success: boolean;
  uploadUrl: string;
  uploadToken: string;
  fileKey: string;
}

export interface ConfirmUploadResponse {
  success: boolean;
  file: {
    id: string;
    fileName: string;
    fileKey: string;
    fileSize: number;
    mimeType: string;
    url: string;
    isPublic: boolean;
  };
}
