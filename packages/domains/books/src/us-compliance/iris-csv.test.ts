import { describe, it, expect } from 'vitest';
import {
  IRIS_MAX_RECORDS_PER_FILE,
  IRIS_MISC_COLUMNS,
  IRIS_NEC_COLUMNS,
  cleanIrisText,
  escapeCsvField,
  generateIrisCsv,
  resolveIrisColumns,
  splitPersonName,
  validateIrisRecipient,
  type IrisPayer,
  type IrisRecipient,
} from './iris-csv';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const payer: IrisPayer = {
  name: 'Weld Test Co',
  tinType: 'ein',
  tin: '12-3456789',
  address: { line1: '100 Main St', city: 'Austin', state: 'tx', zip: '78701' },
  phone: '+1 (512) 555-0100',
  email: 'ap@example.test',
};

const person = (overrides: Partial<IrisRecipient> = {}): IrisRecipient => ({
  id: 'party_1',
  legalName: 'Jane Q. Doe',
  tinType: 'ssn',
  tin: '123-45-6789',
  address: { line1: '5 Elm Street', line2: 'Apt #4', city: 'Dallas', state: 'TX', zip: '75001-1234' },
  accountNumber: 'V-0001',
  boxes: { nec_1: 2500, nec_4: 0 },
  ...overrides,
});

const rowOf = (file: { content: string }, headers: string[], line = 1): Record<string, string> => {
  const rows = parseCsv(file.content);
  const out: Record<string, string> = {};
  headers.forEach((header, index) => {
    out[header] = rows[line]?.[index] ?? '';
  });
  return out;
};

const necHeaders = IRIS_NEC_COLUMNS.map((column) => column.header);

describe('generateIrisCsv', () => {
  it('writes the header row, the payer block, an individual recipient and the amounts', () => {
    const [file] = generateIrisCsv({ taxYear: 2026, form: 'nec', payer, recipients: [person()] });
    expect(file).toBeDefined();
    expect(file!.filename).toBe('iris-1099-nec-2026.csv');
    expect(file!.recordCount).toBe(1);
    expect(file!.content.endsWith('\r\n')).toBe(true);
    const rows = parseCsv(file!.content);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(necHeaders);
    expect(rows[1]).toHaveLength(necHeaders.length);

    const record = rowOf(file!, necHeaders);
    expect(record['Form Type']).toBe('1099-NEC');
    expect(record['Tax Year']).toBe('2026');
    expect(record['Payer TIN Type']).toBe('EIN');
    expect(record['Payer Taxpayer ID Number']).toBe('123456789');
    expect(record['Payer Business or Entity Name Line 1']).toBe('Weld Test Co');
    expect(record['Payer State']).toBe('TX');
    expect(record['Payer Phone Number']).toBe('5125550100');
    expect(record['Recipient TIN Type']).toBe('SSN');
    expect(record['Recipient Taxpayer ID Number']).toBe('123456789');
    expect(record['Recipient Name Type']).toBe('I');
    expect(record['Recipient First Name']).toBe('Jane');
    expect(record['Recipient Middle Name']).toBe('Q');
    expect(record['Recipient Last Name']).toBe('Doe');
    expect(record['Recipient Business or Entity Name Line 1']).toBe('');
    expect(record['Recipient Address Line 2']).toBe('Apt #4');
    expect(record['Recipient ZIP Code']).toBe('750011234');
    expect(record['Form Account Number']).toBe('V-0001');
    expect(record['Box 1 - Nonemployee Compensation']).toBe('2500.00');
    expect(record['Box 4 - Federal Income Tax Withheld']).toBe('');
    expect(record['Corrected']).toBe('N');
    expect(file!.warnings).toEqual([]);
  });

  it('outputs the full recipient TIN and nothing else derived from it', () => {
    const [file] = generateIrisCsv({ taxYear: 2026, form: 'nec', payer, recipients: [person({ tin: '987-65-4321' })] });
    expect(file!.content).toContain('987654321');
    expect(file!.content).not.toContain('987-65-4321');
  });

  it('puts a business recipient on the business name lines with name type B', () => {
    const [file] = generateIrisCsv({
      taxYear: 2026,
      form: 'nec',
      payer,
      recipients: [person({ legalName: 'Acme Plumbing LLC', businessName: 'Acme Plumbing', tinType: 'ein', tin: '98-7654321' })],
    });
    const record = rowOf(file!, necHeaders);
    expect(record['Recipient TIN Type']).toBe('EIN');
    expect(record['Recipient Name Type']).toBe('B');
    expect(record['Recipient Business or Entity Name Line 1']).toBe('Acme Plumbing LLC');
    expect(record['Recipient Business or Entity Name Line 2']).toBe('Acme Plumbing');
    expect(record['Recipient First Name']).toBe('');
  });

  it('files a person with a DBA as name type B: the person on line 1, the DBA on line 2', () => {
    const [file] = generateIrisCsv({
      taxYear: 2026,
      form: 'nec',
      payer,
      recipients: [person({ legalName: 'Jane Doe', businessName: "Jane's Design Studio" })],
    });
    const record = rowOf(file!, necHeaders);
    expect(record['Recipient Name Type']).toBe('B');
    expect(record['Recipient Business or Entity Name Line 1']).toBe('Jane Doe');
    expect(record['Recipient Business or Entity Name Line 2']).toBe("Jane's Design Studio");
    expect(record['Recipient Last Name']).toBe('');
  });

  it('wraps a long business name onto line 2 and warns when text has to be cut', () => {
    const [file] = generateIrisCsv({
      taxYear: 2026,
      form: 'nec',
      payer,
      recipients: [
        person({
          tinType: 'ein',
          tin: '98-7654321',
          legalName: 'International Association of Machinists and Aerospace Workers Local',
          address: { line1: 'X'.repeat(50), city: 'Austin', state: 'TX', zip: '78701' },
        }),
      ],
    });
    const record = rowOf(file!, necHeaders);
    expect(record['Recipient Business or Entity Name Line 1']).toBe('International Association of Machinists');
    expect(record['Recipient Business or Entity Name Line 2']).toBe('and Aerospace Workers Local');
    expect(record['Recipient Address Line 1']).toHaveLength(35);
    expect(file!.warnings.some((warning) => warning.includes('address line 1'))).toBe(true);
  });

  it('splits into files of at most 100 records, each with the header row', () => {
    const recipients = Array.from({ length: 250 }, (_, i) => person({ id: `p${i}`, tin: String(100000000 + i), legalName: `Person Number${i}` }));
    const files = generateIrisCsv({ taxYear: 2026, form: 'nec', payer, recipients });
    expect(IRIS_MAX_RECORDS_PER_FILE).toBe(100);
    expect(files.map((file) => [file.filename, file.recordCount])).toEqual([
      ['iris-1099-nec-2026-001-of-003.csv', 100],
      ['iris-1099-nec-2026-002-of-003.csv', 100],
      ['iris-1099-nec-2026-003-of-003.csv', 50],
    ]);
    for (const file of files) {
      const rows = parseCsv(file.content);
      expect(rows[0]).toEqual(necHeaders);
      expect(rows).toHaveLength(file.recordCount + 1);
    }
    expect(rowOf(files[2]!, necHeaders)['Recipient Taxpayer ID Number']).toBe('100000200');
    expect(generateIrisCsv({ taxYear: 2026, form: 'nec', payer, recipients })).toHaveLength(3);
    expect(generateIrisCsv({ taxYear: 2026, form: 'nec', payer, recipients, maxRecordsPerFile: 500 })).toHaveLength(3);
    expect(generateIrisCsv({ taxYear: 2026, form: 'nec', payer, recipients: [] })).toEqual([]);
  });

  it('writes MISC boxes, checkboxes and two states', () => {
    const miscHeaders = IRIS_MISC_COLUMNS.map((column) => column.header);
    const [file] = generateIrisCsv({
      taxYear: 2026,
      form: 'misc',
      payer,
      recipients: [
        person({
          boxes: { misc_1: 24000, misc_2: 10.5, misc_10: 600, misc_4: 5760 },
          directSales: true,
          states: [
            { code: 'tx', payerStateNumber: 'TX-123', withheld: 12, income: 24000 },
            { code: 'OK', income: 500 },
          ],
        }),
      ],
    });
    expect(file!.filename).toBe('iris-1099-misc-2026.csv');
    const record = rowOf(file!, miscHeaders);
    expect(record['Form Type']).toBe('1099-MISC');
    expect(record['Box 1 - Rents']).toBe('24000.00');
    expect(record['Box 2 - Royalties']).toBe('10.50');
    expect(record['Box 4 - Federal Income Tax Withheld']).toBe('5760.00');
    expect(record['Box 10 - Gross Proceeds Paid to an Attorney']).toBe('600.00');
    expect(record['Box 3 - Other Income']).toBe('');
    expect(record['Box 7 - Direct Sales Indicator']).toBe('Y');
    expect(record['Box 13 - FATCA Filing Requirement']).toBe('N');
    expect(record['State 1 - State Code']).toBe('TX');
    expect(record["State 1 - State/Payer's State No."]).toBe('TX-123');
    expect(record['State 1 - State Tax Withheld']).toBe('12.00');
    expect(record['State 2 - State Income']).toBe('500.00');
  });

  it('quotes fields that need it and strips characters IRIS rejects from names', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField(' padded')).toBe('" padded"');
    expect(cleanIrisText("O'Brien, J.R. & Sons, Inc.")).toBe("O'Brien JR & Sons Inc");
    expect(cleanIrisText('=SUM(A1)')).toBe('SUM(A1)');
    expect(cleanIrisText('-- dash')).toBe('dash');
    expect(cleanIrisText('Zoë  Müller')).toBe('Zoe Muller');
    const [file] = generateIrisCsv({
      taxYear: 2026,
      form: 'nec',
      payer: { ...payer, email: 'a,b@example.test' },
      recipients: [person({ legalName: 'Sam, "Sammy" Lee' })],
    });
    expect(parseCsv(file!.content)[1]).toHaveLength(necHeaders.length);
    expect(rowOf(file!, necHeaders)['Payer Email Address']).toBe('a,b@example.test');
    expect(rowOf(file!, necHeaders)['Recipient First Name']).toBe('Sam');
  });

  it('has no commas in its own headers, since IRIS is sensitive to them', () => {
    for (const column of [...IRIS_NEC_COLUMNS, ...IRIS_MISC_COLUMNS]) expect(column.header).not.toContain(',');
  });

  it('writes the downloaded template header row verbatim and fills columns by name', () => {
    const template = [
      'Form Type*',
      'Tax Year*',
      'Recipient Taxpayer ID Number*',
      'Recipient TIN Type*',
      'Some New 2027 Column',
      'Box 1 - Nonemployee Compensation',
      'Business Name Line 1',
    ];
    const [file] = generateIrisCsv({
      taxYear: 2026,
      form: 'nec',
      payer,
      recipients: [person({ tinType: 'ein', tin: '98-7654321', legalName: 'Acme LLC' })],
      templateHeaders: template,
    });
    const rows = parseCsv(file!.content);
    expect(rows[0]).toEqual(template);
    expect(rows[1]).toEqual(['1099-NEC', '2026', '987654321', 'EIN', '', '2500.00', 'Acme LLC']);
    expect(file!.warnings.some((warning) => warning.includes('Some New 2027 Column'))).toBe(true);
    expect(file!.warnings.some((warning) => warning.startsWith('The template has no column for'))).toBe(true);

    const resolved = resolveIrisColumns('nec', template);
    expect(resolved.unmatchedHeaders).toEqual(['Some New 2027 Column']);
    expect(resolved.missingFields).toContain('payer_tin');
    expect(resolveIrisColumns('nec').missingFields).toEqual([]);
  });

  it('warns about records IRIS would reject', () => {
    const [file] = generateIrisCsv({
      taxYear: 2026,
      form: 'nec',
      payer,
      recipients: [
        person({ id: 'bad-tin', tin: '12345' }),
        person({ id: 'no-amount', tin: '222-33-4444', boxes: {} }),
        person({ id: 'negative', tin: '333-44-5555', boxes: { nec_1: -5 } }),
        person({ id: 'zip', tin: '444-55-6666', address: { line1: '1 A St', city: 'X', state: 'TX', zip: '123' } }),
        person({ id: 'wrong-form', tin: '555-66-7777', boxes: { nec_1: 100, misc_1: 100 } }),
      ],
    });
    const text = file!.warnings.join('\n');
    expect(text).toContain('Recipient bad-tin: The TIN must have 9 digits.');
    expect(text).toContain('Recipient no-amount: No 1099-NEC amount.');
    expect(text).toContain('Recipient negative: Box nec_1 is negative');
    expect(text).toContain('Recipient zip: ZIP code must have 5 or 9 digits.');
    expect(text).toContain('Recipient wrong-form: Box misc_1 belongs to the other form.');
  });

  it('validates a payer TIN too', () => {
    const [file] = generateIrisCsv({ taxYear: 2026, form: 'nec', payer: { ...payer, tin: '1234' }, recipients: [person()] });
    expect(file!.warnings).toContain('Payer: the TIN must have 9 digits.');
    expect(validateIrisRecipient(person(), 'nec')).toEqual([]);
  });
});

describe('person names', () => {
  it('splits first, middle, last and suffix', () => {
    expect(splitPersonName('John Q. Public Jr.')).toEqual({ first: 'John', middle: 'Q', last: 'Public', suffix: 'Jr' });
    expect(splitPersonName('Maria de la Cruz')).toEqual({ first: 'Maria', middle: 'de la', last: 'Cruz', suffix: '' });
    expect(splitPersonName('Cher')).toEqual({ first: '', middle: '', last: 'Cher', suffix: '' });
    expect(splitPersonName('Ann Lee')).toEqual({ first: 'Ann', middle: '', last: 'Lee', suffix: '' });
  });

  it('uses given name parts over parsing', () => {
    const [file] = generateIrisCsv({
      taxYear: 2026,
      form: 'nec',
      payer,
      recipients: [person({ legalName: 'Jean Claude Van Damme', nameParts: { first: 'Jean Claude', last: 'Van Damme' } })],
    });
    const record = rowOf(file!, necHeaders);
    expect(record['Recipient First Name']).toBe('Jean Claude');
    expect(record['Recipient Last Name']).toBe('Van Damme');
  });
});
