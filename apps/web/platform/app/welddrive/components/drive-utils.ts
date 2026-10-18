import type { DriveFile, UnifiedFile } from '@/lib/api/domains/welddrive';
import type { useI18n } from '@/lib/i18n/provider';

type DriveTranslations = ReturnType<typeof useI18n>['t'];

/** Drive files a module stores for one of its records (WeldFlow sheets and documents). */
const PROJECT_ENTITY_TYPES = new Set(['project', 'project_document']);

/**
 * Where a file comes from, for its Source badge: a WeldFlow sheet or document
 * kept in Drive counts as the project's, not as an upload to My Drive.
 */
export function driveSourceKey(file: Pick<UnifiedFile, 'source' | 'entityType'>): string {
  if (file.source === 'drive' && file.entityType && PROJECT_ENTITY_TYPES.has(file.entityType)) return 'projects';
  return file.source;
}

/** The Source badge text, the same in every view (My Drive, Uploads, Trash, …). */
export function driveSourceLabel(
  file: Pick<UnifiedFile, 'source' | 'sourceLabel' | 'entityType'>,
  t: DriveTranslations,
): string {
  const sources = t.welddrive.page.filters.sources;
  const key = driveSourceKey(file);
  if (key === 'drive') return sources.myDrive;
  return (sources as Record<string, string>)[key] ?? file.sourceLabel;
}

/** A file someone uploaded to Drive itself, as opposed to one a module keeps for a record. */
export function isDriveUpload(file: Pick<UnifiedFile, 'source' | 'entityType'>): boolean {
  return file.source === 'drive' && !file.entityType;
}

/**
 * The in-app link to an item, for "Copy link" and Share: it opens the file
 * where clicking it in the list does (its editor or module page, else the
 * WeldDrive preview), instead of handing out the raw storage URL.
 */
export function driveItemLink(
  file: Pick<UnifiedFile, 'id' | 'source' | 'isWeldDoc' | 'navigateTo' | 'url'>,
): string | null {
  const origin = window.location.origin;
  if (file.isWeldDoc) return `${origin}/documents/${encodeURIComponent(file.id)}`;
  // A drive file with a module route (a WeldFlow sheet) opens there, not in the preview.
  if (file.navigateTo) return `${origin}${file.navigateTo}`;
  if (file.source === 'drive') return `${origin}/welddrive?file=${encodeURIComponent(file.id)}`;
  return file.url;
}

/** A raw `files` row (trash, a shared link) in the shape the Drive views render. */
export function driveFileToUnified(f: DriveFile): UnifiedFile {
  const description = f.metadata?.description;
  return {
    id: f.id,
    name: f.fileName,
    fileType: f.fileType || 'file',
    mimeType: f.mimeType,
    fileSize: f.fileSize,
    url: f.url,
    thumbnailUrl: f.thumbnailUrl,
    source: 'drive',
    sourceLabel: '',
    navigateTo: null,
    folderId: f.folderId,
    isStarred: f.isStarred,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    uploadedById: f.uploadedById,
    deletedAt: f.deletedAt,
    isWeldDoc: f.metadata?.welddoc === true,
    entityType: f.entityType,
    description: typeof description === 'string' ? description : null,
  };
}

/** "report.final.pdf" → ["report.final", ".pdf"]; no extension (or a dotfile) → [name, ""]. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'conf',
  'cfg', 'toml', 'env', 'sql', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'html', 'htm', 'sh', 'py',
  'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'rb', 'php', 'swift',
]);

const TEXT_MIME_TYPES = /^application\/(json|xml|x-yaml|yaml|x-sh|javascript|x-javascript|sql|x-ndjson)\b/;

/** Plain-text files the preview can show as text (Drive files only: read through the content endpoint). */
export function isTextPreviewable(file: Pick<UnifiedFile, 'source' | 'mimeType' | 'name'>): boolean {
  if (file.source !== 'drive') return false;
  const mime = file.mimeType ?? '';
  if (mime.startsWith('text/') || TEXT_MIME_TYPES.test(mime)) return true;
  const ext = splitExtension(file.name)[1].slice(1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * "PNG file", "TXT file", "Image file": the kind of file, for the preview's
 * fallback. A generic `file` type is named after its extension rather than
 * reading "File file".
 */
export function fileKindLabel(file: Pick<UnifiedFile, 'name' | 'fileType'>, t: DriveTranslations): string {
  const template = t.welddrive.filePreview.unsupported.fileLabel;
  if (file.fileType !== 'file') {
    const type = file.fileType.replaceAll('-', ' ');
    return template.replace('{fileType}', type.charAt(0).toUpperCase() + type.slice(1));
  }
  const ext = splitExtension(file.name)[1].slice(1);
  return ext ? template.replace('{fileType}', ext.toUpperCase()) : t.welddrive.common.file;
}
