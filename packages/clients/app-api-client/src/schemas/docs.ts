/**
 * WeldDocs: the contract between docs-api and the platform. Zod v3.
 *
 * A document is a WeldDrive file (`files`) plus a `docs` row. These routes
 * create, list, rename and trash it and open a session on it; the content
 * itself only travels over the document's room socket (the
 * @weldsuite/docs-engine collab protocol). See docs/plans/welddocs.md.
 */

import { z } from 'zod';

/** MIME type of a WeldDocs document's drive file (it has no file of its own to download). */
export const WELDDOC_MIME_TYPE = 'application/vnd.weldsuite.doc+json';

/** Path of the room socket; the session ticket goes in `?ticket=`. */
export const DOC_CONNECT_PATH = '/api/docs/connect';

/** Largest initial snapshot `POST /api/docs` takes, as JSON. */
export const DOC_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;

/** Name a document gets when none is given. */
export const DEFAULT_DOC_NAME = 'Untitled document';

const docName = z.string().trim().min(1).max(255);

/**
 * A document snapshot (`DocSnapshot` in @weldsuite/docs-engine), typed by its
 * version alone: docs-api loads it with the engine, which checks the rest.
 */
export interface DocSnapshotLike {
  version: number;
}

const docSnapshot = z.custom<DocSnapshotLike>(
  (v) => typeof v === 'object' && v !== null && Number.isInteger((v as { version?: unknown }).version),
  'Expected a document snapshot',
);

export const createDocSchema = z.object({
  name: docName.optional(),
  folderId: z.string().nullish(),
  /** The content to start from (an imported file); default one empty paragraph. */
  snapshot: docSnapshot.optional(),
});
export type CreateDocInput = z.infer<typeof createDocSchema>;

export const updateDocSchema = z
  .object({
    name: docName.optional(),
    /** Move to a folder; null moves it to My Drive. */
    folderId: z.string().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.folderId !== undefined, 'Send a name or a folder');
export type UpdateDocInput = z.infer<typeof updateDocSchema>;

export const listDocsQuerySchema = z.object({
  search: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
});
export type ListDocsQuery = z.infer<typeof listDocsQuerySchema>;

export type DocRole = 'owner' | 'editor' | 'viewer';

export interface DocSummary {
  id: string;
  /** The backing drive file. */
  fileId: string;
  name: string;
  folderId: string | null;
  createdAt: string;
  /** Last change to the name or the content (content as of the room's last checkpoint). */
  updatedAt: string;
  createdById: string | null;
  updatedById: string | null;
  /** The room's revision at its last checkpoint (the live room may be a few edits ahead). */
  revision: number;
  /** The caller's role on the drive file. */
  role: DocRole;
  /** The caller may change it: the role allows it and they hold `docs:update`. */
  canEdit: boolean;
}

/**
 * What the room lets this person do: `edit` everything; `comment` only add,
 * edit and delete their own comments and resolve or reopen discussions (a
 * viewer with `docs:comment`); `view` nothing (any other op is refused).
 */
export type DocSessionMode = 'edit' | 'comment' | 'view';

export interface DocSession {
  /** Single-use, valid for a minute: `${DOC_CONNECT_PATH}?ticket=…` opens the room. */
  ticket: string;
  /** Same as `mode === 'edit'`. */
  canEdit: boolean;
  mode: DocSessionMode;
  /** This person's colour in the room (caret, selection, avatar). */
  color: string;
}

/**
 * The room's live document (`GET /api/docs/:id/snapshot`), edits not yet
 * checkpointed included; or a saved version's
 * (`GET /api/docs/:id/versions/:versionId/snapshot`).
 */
export interface DocSnapshotResponse<Snapshot = DocSnapshotLike> {
  revision: number;
  snapshot: Snapshot;
}

// ---------------------------------------------------------------- versions

const versionName = z.string().trim().min(1).max(255);

/** `POST /api/docs/:id/versions`: save the document as it is now under a name. */
export const createDocVersionSchema = z.object({ name: versionName });
export type CreateDocVersionInput = z.infer<typeof createDocVersionSchema>;

/** `PATCH /api/docs/:id/versions/:versionId`: rename a version. */
export const updateDocVersionSchema = z.object({ name: versionName });
export type UpdateDocVersionInput = z.infer<typeof updateDocVersionSchema>;

/** `GET /api/docs/:id/versions`: newest first; `cursor` is the previous page's `pagination.cursor`. */
export const listDocVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(255).optional(),
});
export type ListDocVersionsQuery = z.infer<typeof listDocVersionsQuerySchema>;

/** A saved copy of a document at one revision. */
export interface DocVersion {
  id: string;
  docId: string;
  /** The room's revision the copy is at. */
  revision: number;
  /** Null for an automatic version (the document as it was before a restore). */
  name: string | null;
  /** Size of the stored snapshot, bytes. */
  size: number;
  createdAt: string;
  createdById: string | null;
}

/** `POST /api/docs/:id/versions/:versionId/restore`. */
export interface DocRestoreResult {
  /** The document's revision after the restore: the room's revision before it, plus one. */
  revision: number;
  /** The document as it was just before the restore, saved as an automatic version. */
  autoVersion: DocVersion;
}
