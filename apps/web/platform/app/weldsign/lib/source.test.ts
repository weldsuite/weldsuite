import { describe, expect, it } from 'vitest';
import { SIGN_SOURCE_TYPES } from '@weldsuite/app-api-client/schemas/weldsign';
import { clampTitle, driveFolderHref, fileTitle, isSignablePdf, sourceHref } from './source';

describe('sourceHref', () => {
  it('opens a file in the WeldDrive preview', () => {
    expect(sourceHref('file', 'fil_1')).toBe('/welddrive?file=fil_1');
  });

  it('opens a company and a person in the CRM side panel, as the activity log does', () => {
    expect(sourceHref('company', 'cus_1')).toBe('/weldcrm/companies?stack=company:cus_1:panel');
    expect(sourceHref('person', 'per_1')).toBe('/weldcrm/people?stack=person:per_1:panel');
  });

  it('opens an opportunity in the entity sheet, which has no page of its own', () => {
    expect(sourceHref('opportunity', 'opp_1')).toBe('/weldcrm?entity=opportunity:opp_1');
  });

  it('has an address for every source type', () => {
    for (const type of SIGN_SOURCE_TYPES) expect(sourceHref(type, 'x_1'), type).toMatch(/^\/(welddrive|weldcrm)/);
  });

  it('escapes the id', () => {
    expect(sourceHref('file', 'a b&c')).toBe('/welddrive?file=a%20b%26c');
  });
});

describe('driveFolderHref', () => {
  it('opens the folder in WeldDrive', () => {
    expect(driveFolderHref('fld_1')).toBe('/welddrive?folderId=fld_1');
  });
});

describe('fileTitle', () => {
  it('is the file name without .pdf, whatever the case', () => {
    expect(fileTitle('Service agreement.pdf', 'Untitled')).toBe('Service agreement');
    expect(fileTitle('NDA.PDF', 'Untitled')).toBe('NDA');
    expect(fileTitle('  Offer v2.pdf  ', 'Untitled')).toBe('Offer v2');
  });

  it('keeps a name that merely contains ".pdf" or has another extension', () => {
    expect(fileTitle('report.pdf.docx', 'Untitled')).toBe('report.pdf.docx');
    expect(fileTitle('contract', 'Untitled')).toBe('contract');
  });

  it('keeps the whole name when removing .pdf would leave nothing, and falls back to the untitled label', () => {
    expect(fileTitle('.pdf', 'Untitled')).toBe('.pdf');
    expect(fileTitle('   ', 'Untitled')).toBe('Untitled');
  });

  it('is no longer than the API takes', () => {
    expect(fileTitle(`${'a'.repeat(300)}.pdf`, 'Untitled')).toHaveLength(255);
    expect(clampTitle('b'.repeat(300))).toHaveLength(255);
    expect(clampTitle('short')).toBe('short');
  });
});

describe('isSignablePdf', () => {
  const file = { name: 'Contract.pdf', mimeType: 'application/pdf', fileType: 'pdf', source: 'drive' };

  it('accepts a PDF of the WeldDrive file store', () => {
    expect(isSignablePdf(file)).toBe(true);
  });

  it('goes by the type, the mime type or the name, as files are labelled differently by where they came from', () => {
    expect(isSignablePdf({ ...file, mimeType: null, name: 'scan' })).toBe(true);
    expect(isSignablePdf({ ...file, fileType: 'file', name: 'scan' })).toBe(true);
    expect(isSignablePdf({ ...file, fileType: 'file', mimeType: null })).toBe(true);
  });

  it('refuses other files and files of other modules', () => {
    expect(isSignablePdf({ name: 'Budget.xlsx', mimeType: 'application/vnd.ms-excel', fileType: 'spreadsheet', source: 'drive' })).toBe(false);
    expect(isSignablePdf({ name: 'Notes', mimeType: null, fileType: 'rich-document', source: 'drive' })).toBe(false);
    expect(isSignablePdf({ ...file, source: 'mail' })).toBe(false);
  });
});
