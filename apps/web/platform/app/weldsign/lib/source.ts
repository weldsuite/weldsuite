/**
 * Where a request started and where its signed copy went: the page of a
 * WeldDrive file or folder and of a CRM record, the title of a request made
 * from one, and which Drive files can start a request at all.
 */

import type { SignSourceType } from '@weldsuite/app-api-client/schemas/weldsign';

/** The longest request title the API takes. */
const MAX_TITLE = 255;

/** The WeldDrive file or CRM record a request is made from. */
export interface SignStartSource {
  entityType: SignSourceType;
  id: string;
  /** The file's or record's name, for the title of the draft. */
  name: string;
}

/**
 * Where a source opens. A company and a person open in the CRM's side panel
 * (`?stack=`); an opportunity has no page of its own, only the entity sheet
 * (`?entity=`) that any page can show; a file opens in WeldDrive's preview.
 */
export function sourceHref(entityType: SignSourceType, entityId: string): string {
  const id = encodeURIComponent(entityId);
  switch (entityType) {
    case 'file':
      return `/welddrive?file=${id}`;
    case 'company':
      return `/weldcrm/companies?stack=company:${id}:panel`;
    case 'person':
      return `/weldcrm/people?stack=person:${id}:panel`;
    case 'opportunity':
      return `/weldcrm?entity=opportunity:${id}`;
  }
}

export function driveFolderHref(folderId: string): string {
  return `/welddrive?folderId=${encodeURIComponent(folderId)}`;
}

/** The title of a draft made from a WeldDrive file: its name without ".pdf". */
export function fileTitle(fileName: string, untitled: string): string {
  const name = fileName.trim().replace(/\.pdf$/i, '').trim() || fileName.trim() || untitled;
  return name.slice(0, MAX_TITLE);
}

/** A title the API accepts: no longer than it takes. */
export function clampTitle(title: string): string {
  return title.slice(0, MAX_TITLE);
}

interface DriveFileLike {
  name: string;
  mimeType: string | null;
  fileType: string;
  source: string;
}

/**
 * A PDF in the WeldDrive file store. A WeldDoc, a spreadsheet or a file of
 * another module can not be signed; the server checks the PDF itself.
 */
export function isSignablePdf(file: DriveFileLike): boolean {
  if (file.source !== 'drive') return false;
  return file.fileType === 'pdf' || file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name);
}
