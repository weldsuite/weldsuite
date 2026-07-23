/**
 * Maps an attachment filename to a visual "kind" + accent color so the reader
 * can show a Gmail/Outlook-style typed icon instead of a generic paperclip.
 * Pure (no RN deps) so the caller picks the actual icon component by `kind`.
 */
export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'video'
  | 'audio'
  | 'file';

export interface AttachmentVisual {
  kind: AttachmentKind;
  /** Accent color for the icon + tinted badge. */
  color: string;
  /** Uppercase extension label, e.g. "PDF" (empty when unknown). */
  ext: string;
}

const EXT_MAP: Record<string, AttachmentKind> = {
  // images
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', bmp: 'image', svg: 'image', tiff: 'image',
  // documents
  pdf: 'pdf',
  doc: 'doc', docx: 'doc', rtf: 'doc', txt: 'doc', pages: 'doc', odt: 'doc',
  // spreadsheets
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', numbers: 'sheet', ods: 'sheet',
  // presentations
  ppt: 'slides', pptx: 'slides', key: 'slides', odp: 'slides',
  // archives
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  // media
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio',
};

const KIND_COLOR: Record<AttachmentKind, string> = {
  image: '#8B5CF6',
  pdf: '#EF4444',
  doc: '#2563EB',
  sheet: '#16A34A',
  slides: '#F97316',
  archive: '#D97706',
  video: '#DB2777',
  audio: '#0EA5E9',
  file: '#6B7280',
};

export function getAttachmentVisual(name?: string | null): AttachmentVisual {
  const ext = (name?.split('.').pop() || '').toLowerCase();
  const kind = EXT_MAP[ext] || 'file';
  return {
    kind,
    color: KIND_COLOR[kind],
    ext: ext && ext.length <= 5 ? ext.toUpperCase() : '',
  };
}
