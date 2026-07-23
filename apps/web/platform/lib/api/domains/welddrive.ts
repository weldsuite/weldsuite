/**
 * WeldDrive types — thin re-export shim over the shared schema package.
 *
 * The canonical types now live in `@weldsuite/core-api-client/schemas/files`,
 * `/schemas/folders`, and `/schemas/drive`. Keeping this file as a shim so
 * existing imports (`@/lib/api/domains/welddrive`) keep working until they
 * are updated one-by-one. Safe to delete once nothing imports from here.
 */

export type {
  
  
  DriveFile,
  UnifiedFile,
  ListFilesQuery as DriveFilesParams,
  CreateFileInput,
  PaginationMeta,
  FilesListResponse as DriveFilesResponse,
} from '@weldsuite/core-api-client/schemas/files';

export type {
  DriveFolder,
  CreateFolderInput,
} from '@weldsuite/core-api-client/schemas/folders';

export type { DriveStatsResponse } from '@weldsuite/core-api-client/schemas/drive';
