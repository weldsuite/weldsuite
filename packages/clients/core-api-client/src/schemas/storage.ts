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
  /** false (default): the private bucket, readable by workspace members only.
   *  true: the public bucket, for anything shown outside the workspace. */
  isPublic: z.boolean().optional().default(false),
});

export const confirmUploadSchema = z.object({
  uploadToken: z.string().min(1),
  fileKey: z.string().min(1),
  etag: z.string().optional(),
});

export type GenerateUploadUrlInput = z.infer<typeof generateUploadUrlSchema>;
export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;

/** `private` objects are served by app-api `/api/storage/private/*` only. */
export const storageBucketSchema = z.enum(['public', 'private']);
export type StorageBucket = z.infer<typeof storageBucketSchema>;

/** `POST /generate-upload-url` (not enveloped). */
export const generateUploadUrlResponseSchema = z.object({
  success: z.boolean(),
  uploadUrl: z.string(),
  uploadToken: z.string(),
  fileKey: z.string(),
  bucket: storageBucketSchema,
});
export type GenerateUploadUrlResponse = z.infer<typeof generateUploadUrlResponseSchema>;

/** `POST /confirm-upload` (not enveloped). */
export const confirmUploadResponseSchema = z.object({
  success: z.boolean(),
  file: z.object({
    id: z.string(),
    fileName: z.string(),
    fileKey: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    url: z.string(),
    isPublic: z.boolean(),
    bucket: storageBucketSchema,
  }),
});
export type ConfirmUploadResponse = z.infer<typeof confirmUploadResponseSchema>;

/** `POST /access` → `{ data }`: the files cookie is set; refresh before `expiresAt` (Unix seconds). */
export const filesAccessSchema = z.object({
  workspaceId: z.string(),
  expiresAt: z.number().int(),
});
export type FilesAccess = z.infer<typeof filesAccessSchema>;

/** One signed object URL from `POST /sign`. */
export const signedObjectUrlSchema = z.object({
  url: z.string(),
  expiresAt: z.number().int(),
});

/** `POST /sign` → `{ data }`: each reference of the caller's workspace to its signed URL. */
export const signedObjectUrlsSchema = z.record(signedObjectUrlSchema);
export type SignedObjectUrls = z.infer<typeof signedObjectUrlsSchema>;

/** `POST /migrate-private` → `{ data }`: one batch of moving private drive files. */
export const privateFilesMigrationBatchSchema = z.object({
  moved: z.number().int(),
  repointed: z.number().int(),
  skipped: z.array(
    z.object({
      id: z.string(),
      reason: z.enum(['no-key', 'foreign-key', 'missing-object']),
    }),
  ),
  updated: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      folderId: z.string().nullable(),
      fileType: z.string(),
      url: z.string(),
    }),
  ),
  cursor: z.string().nullable(),
  done: z.boolean(),
});
export type PrivateFilesMigrationBatch = z.infer<typeof privateFilesMigrationBatchSchema>;
