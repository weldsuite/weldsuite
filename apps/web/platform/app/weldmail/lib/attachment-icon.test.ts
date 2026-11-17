import { describe, expect, it } from 'vitest';
import {
  File,
  FileArchive,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  Presentation,
} from 'lucide-react';
import { attachmentIcon } from './attachment-icon';

describe('attachmentIcon', () => {
  it.each([
    ['PO-88213.pdf', File],
    ['Northwind-partnership-draft.docx', FileText],
    ['Q4-forecast.XLSX', FileSpreadsheet],
    ['Kickoff.pptx', Presentation],
    ['Warehouse.jpg', FileImage],
    ['Product-demo.mp4', FileVideoCamera],
    ['Voicemail.m4a', FileMusic],
    ['Brand-assets.zip', FileArchive],
  ])('picks the icon of %s by its extension', (fileName, icon) => {
    expect(attachmentIcon(fileName)).toBe(icon);
  });

  it('falls back to the MIME type, then to the plain file icon', () => {
    expect(attachmentIcon('scan', 'image/png')).toBe(FileImage);
    expect(attachmentIcon('recording', 'audio/mpeg')).toBe(FileMusic);
    expect(attachmentIcon('data.bin', 'application/octet-stream')).toBe(File);
    expect(attachmentIcon('.hidden')).toBe(File);
  });
});
