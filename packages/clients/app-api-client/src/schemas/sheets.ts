/**
 * WeldSheets — the contract between sheets-api and the platform. Zod v3.
 *
 * A spreadsheet is a WeldDrive file (`files`) plus a `sheets` row. These
 * routes create, list, rename and trash it and open a session on it; the
 * workbook itself only travels over the sheet's room socket (the
 * @weldsuite/sheets-engine collab protocol). See docs/plans/weldsheets.md.
 */

import { z } from 'zod';

/** MIME type of a spreadsheet's drive file (it has no file of its own to download). */
export const WELDSHEET_MIME_TYPE = 'application/vnd.weldsuite.spreadsheet';

/** Path of the room socket; the session ticket goes in `?ticket=`. */
export const SHEET_CONNECT_PATH = '/api/sheets/connect';

const sheetName = z.string().trim().min(1).max(255);

export const createSheetSchema = z.object({
  name: sheetName,
  folderId: z.string().nullish(),
  /** Name of the first tab, in the creator's language ("Sheet1", "Blad1"). */
  firstTabName: z.string().trim().min(1).max(100).optional(),
});
export type CreateSheetInput = z.infer<typeof createSheetSchema>;

export const updateSheetSchema = z.object({
  name: sheetName,
});
export type UpdateSheetInput = z.infer<typeof updateSheetSchema>;

export const listSheetsQuerySchema = z.object({
  search: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
});
export type ListSheetsQuery = z.infer<typeof listSheetsQuerySchema>;

export type SheetRole = 'owner' | 'editor' | 'viewer';

export interface SheetSummary {
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
  /** The caller's role on the drive file. */
  role: SheetRole;
  /** The caller may change it: the role allows it and they hold `sheets:update`. */
  canEdit: boolean;
}

export interface SheetSession {
  /** Single-use, valid for a minute: `${SHEET_CONNECT_PATH}?ticket=…` opens the room. */
  ticket: string;
  canEdit: boolean;
  /** This person's colour in the room (cursor, selection, avatar). */
  color: string;
}
