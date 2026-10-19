import { describe, expect, it } from 'vitest';
import type { DriveFolder, UnifiedFile } from '@/lib/api/domains/welddrive';
import {
  driveItemLink,
  driveSourceLabel,
  fileKindLabel,
  isDriveUpload,
  isTextPreviewable,
  splitExtension,
} from './drive-utils';
import { resolveDriveRename } from './drive-rename-dialog';
import { folderTreeOptions } from './move-to-folder-dialog';

const t = {
  welddrive: {
    common: { file: 'File' },
    filePreview: { unsupported: { fileLabel: '{fileType} file' } },
    page: {
      filters: {
        sources: { myDrive: 'My Drive', projects: 'Projects', mail: 'Mail' },
      },
    },
  },
} as unknown as Parameters<typeof driveSourceLabel>[1];

function file(over: Partial<UnifiedFile> = {}): UnifiedFile {
  return {
    id: 'fil_1',
    name: 'contract-e2e.txt',
    fileType: 'file',
    mimeType: 'text/plain',
    fileSize: 600,
    url: 'https://storage.example/workspaces/w/contract-e2e.txt',
    thumbnailUrl: null,
    source: 'drive',
    sourceLabel: 'My Drive',
    navigateTo: null,
    folderId: null,
    isStarred: false,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: null,
    uploadedById: 'user_1',
    ...over,
  };
}

function folder(id: string, name: string, parentId: string | null): DriveFolder {
  return {
    id,
    name,
    parentId,
    generalAccess: 'workspace_edit',
    color: null,
    icon: null,
    createdById: null,
    metadata: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    deletedAt: null,
  };
}

describe('splitExtension', () => {
  it('splits at the last dot, leaving dotfiles and extension-less names whole', () => {
    expect(splitExtension('E2E image.png')).toEqual(['E2E image', '.png']);
    expect(splitExtension('report.final.pdf')).toEqual(['report.final', '.pdf']);
    expect(splitExtension('README')).toEqual(['README', '']);
    expect(splitExtension('.env')).toEqual(['.env', '']);
    expect(splitExtension('trailing.')).toEqual(['trailing.', '']);
  });
});

describe('resolveDriveRename', () => {
  it('keeps the extension when the new name has none', () => {
    expect(resolveDriveRename('E2E renamed', 'E2E image.png', true)).toBe('E2E renamed.png');
    expect(resolveDriveRename('  E2E renamed  ', 'E2E image.png', true)).toBe('E2E renamed.png');
  });

  it('uses a typed extension as is', () => {
    expect(resolveDriveRename('photo.jpg', 'E2E image.png', true)).toBe('photo.jpg');
  });

  it('leaves folders and extension-less files alone', () => {
    expect(resolveDriveRename('Contracts 2026', 'Contracts', false)).toBe('Contracts 2026');
    expect(resolveDriveRename('NOTES', 'README', true)).toBe('NOTES');
  });
});

describe('driveSourceLabel', () => {
  it('labels drive files My Drive in every view, and WeldFlow files as Projects', () => {
    expect(driveSourceLabel(file({ sourceLabel: '' }), t)).toBe('My Drive');
    expect(driveSourceLabel(file({ entityType: 'project' }), t)).toBe('Projects');
    expect(driveSourceLabel(file({ entityType: 'project_document' }), t)).toBe('Projects');
    expect(driveSourceLabel(file({ source: 'mail', sourceLabel: 'Mail' }), t)).toBe('Mail');
  });
});

describe('isDriveUpload', () => {
  it('counts plain drive files only', () => {
    expect(isDriveUpload(file())).toBe(true);
    expect(isDriveUpload(file({ entityType: 'project' }))).toBe(false);
    expect(isDriveUpload(file({ source: 'mail' }))).toBe(false);
  });
});

describe('driveItemLink', () => {
  it('links into the app instead of the storage URL', () => {
    const origin = window.location.origin;
    expect(driveItemLink(file())).toBe(`${origin}/welddrive?file=fil_1`);
    expect(driveItemLink(file({ isWeldDoc: true }))).toBe(`${origin}/documents/fil_1`);
    expect(driveItemLink(file({ source: 'mail', navigateTo: '/weldmail/unified/inbox/msg_1' }))).toBe(
      `${origin}/weldmail/unified/inbox/msg_1`,
    );
  });

  it('sends a drive file with a module route (a WeldFlow sheet) to that route', () => {
    const sheet = file({
      entityType: 'project',
      fileType: 'spreadsheet',
      navigateTo: '/weldflow/project/prj_1/table/fil_1',
    });
    expect(driveItemLink(sheet)).toBe(`${window.location.origin}/weldflow/project/prj_1/table/fil_1`);
  });
});

describe('isTextPreviewable', () => {
  it('previews plain text drive files by MIME type or extension', () => {
    expect(isTextPreviewable(file())).toBe(true);
    expect(isTextPreviewable(file({ mimeType: 'application/octet-stream', name: 'notes.md' }))).toBe(true);
    expect(isTextPreviewable(file({ mimeType: 'application/json', name: 'data' }))).toBe(true);
    expect(isTextPreviewable(file({ mimeType: 'image/png', name: 'E2E image.png' }))).toBe(false);
    expect(isTextPreviewable(file({ source: 'mail' }))).toBe(false);
  });
});

describe('fileKindLabel', () => {
  it('names a generic file after its extension instead of "File File"', () => {
    expect(fileKindLabel(file(), t)).toBe('TXT file');
    expect(fileKindLabel(file({ name: 'README' }), t)).toBe('File');
    expect(fileKindLabel(file({ fileType: 'rich-document', name: 'Plan' }), t)).toBe('Rich document file');
  });
});

describe('folderTreeOptions', () => {
  const folders = [
    folder('fld_b', 'B', null),
    folder('fld_a', 'A', null),
    folder('fld_a1', 'A1', 'fld_a'),
    folder('fld_a1x', 'A1x', 'fld_a1'),
  ];

  it('lists folders depth-first by name with their depth', () => {
    expect(folderTreeOptions(folders).map((o) => [o.folder.id, o.depth])).toEqual([
      ['fld_a', 0],
      ['fld_a1', 1],
      ['fld_a1x', 2],
      ['fld_b', 0],
    ]);
  });

  it('leaves out the folder being moved and everything under it', () => {
    expect(folderTreeOptions(folders, 'fld_a').map((o) => o.folder.id)).toEqual(['fld_b']);
    expect(folderTreeOptions(folders, 'fld_a1').map((o) => o.folder.id)).toEqual(['fld_a', 'fld_b']);
  });
});
