import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REACH_IMPORT_MAX_ROWS } from '@weldsuite/app-api-client/schemas/reach';
import {
  page,
  renderWithApp,
  stubRadixBrowserApis,
} from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({
  importProspects: vi.fn(),
  listLists: vi.fn(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));

import { CsvImport } from './csv-import';

/** jsdom's File has no arrayBuffer(), which `readTextFile` uses. */
function csvFile(text: string, name = 'prospects.csv'): File {
  const file = new File([text], name, { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  return file;
}

async function upload(user: ReturnType<typeof userEvent.setup>, file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, file);
}

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  reach.importProspects.mockReset();
  reach.listLists.mockReset();
  reach.listLists.mockResolvedValue(page([]));
  reach.importProspects.mockResolvedValue({
    data: { listId: 'lst_1', created: 2, updated: 0, skipped: [{ reason: 'consumer', count: 1 }] },
  });
});

const CSV = [
  'E-mail,Voornaam,Achternaam,Bedrijf,Branche',
  'ana@acme.com,Ana,Jansen,Acme,Software',
  'bo@gmail.com,Bo,Smit,,Retail',
  'info@widgets.nl,,,Widgets,',
  'not-an-email,Cy,Cyco,Cyco,Energy',
  'ANA@acme.com,Ana,Again,Acme,Software',
].join('\n');

describe('CsvImport', () => {
  it('guesses the columns, shows what will likely be skipped, and sends the mapped rows', async () => {
    const user = userEvent.setup();
    renderWithApp(<CsvImport onClose={vi.fn()} onViewList={vi.fn()} />);

    await upload(user, csvFile(CSV));

    // Dutch headers are recognised and the file summary is shown.
    expect(await screen.findByText('prospects.csv')).toBeInTheDocument();
    expect(screen.getByText('Ready to import: 3 of 5 rows.')).toBeInTheDocument();
    expect(screen.getByText(/Rows without a valid email address \(not imported\): 1/)).toBeInTheDocument();
    expect(screen.getByText(/Repeated addresses in the file \(imported once\): 1/)).toBeInTheDocument();
    expect(screen.getByText(/Free-mail and consumer addresses in the file: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Role addresses \(info@, sales@, …\) in the file: 1/)).toBeInTheDocument();
    // The unmapped column is offered as a custom field under a usable key.
    expect(screen.getByText('{{branche}}')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import 3 rows' }));

    await waitFor(() => expect(reach.importProspects).toHaveBeenCalledTimes(1));
    const input = reach.importProspects.mock.calls[0]?.[0] as {
      rows: Array<Record<string, unknown>>;
      listName?: string;
      sourceRef?: string;
    };
    expect(input.listName).toBe('prospects');
    expect(input.sourceRef).toBe('prospects.csv');
    expect(input.rows.map((row) => row.email)).toEqual(['ana@acme.com', 'bo@gmail.com', 'info@widgets.nl']);
    expect(input.rows[0]).toMatchObject({
      firstName: 'Ana',
      lastName: 'Jansen',
      companyName: 'Acme',
      customFields: { branche: 'Software' },
    });

    // The report adds the rows that were never sent to the server's own skips.
    const report = await screen.findByText(/Import finished/);
    expect(report).toHaveTextContent('Created 2, updated 0');
    const reasons = screen.getByText('Why rows were skipped').parentElement as HTMLElement;
    expect(within(reasons).getByText('Free-mail and consumer addresses')).toBeInTheDocument();
    expect(within(reasons).getByText('Rows without an email address')).toBeInTheDocument();
    expect(within(reasons).getByText('Repeated in the file')).toBeInTheDocument();
  });

  it('sends large files in chunks and fills one list', async () => {
    const user = userEvent.setup();
    const total = REACH_IMPORT_MAX_ROWS + 3;
    const rows = Array.from({ length: total }, (_, index) => `person${index}@company${index}.com,Person ${index}`);
    reach.importProspects
      .mockResolvedValueOnce({ data: { listId: 'lst_9', created: REACH_IMPORT_MAX_ROWS, updated: 0, skipped: [] } })
      .mockResolvedValueOnce({ data: { listId: 'lst_9', created: 3, updated: 0, skipped: [] } });
    renderWithApp(<CsvImport onClose={vi.fn()} onViewList={vi.fn()} />);

    await upload(user, csvFile(['email,first name', ...rows].join('\n'), 'big.csv'));
    await user.click(await screen.findByRole('button', { name: /^Import .* rows$/ }));

    await waitFor(() => expect(reach.importProspects).toHaveBeenCalledTimes(2));
    const first = reach.importProspects.mock.calls[0]?.[0] as { rows: unknown[]; listId?: string; listName?: string };
    const second = reach.importProspects.mock.calls[1]?.[0] as { rows: unknown[]; listId?: string; listName?: string };
    expect(first.rows).toHaveLength(REACH_IMPORT_MAX_ROWS);
    expect(first.listName).toBe('big');
    expect(first.listId).toBeUndefined();
    expect(second.rows).toHaveLength(3);
    // The second request adds to the list the first one created instead of making another.
    expect(second.listId).toBe('lst_9');
    expect(second.listName).toBeUndefined();
    expect(await screen.findByText(/Created 5,003, updated 0/)).toBeInTheDocument();
  });

  it('asks for the email column before it will import', async () => {
    const user = userEvent.setup();
    renderWithApp(<CsvImport onClose={vi.fn()} onViewList={vi.fn()} />);

    await upload(user, csvFile('name,company\nAna,Acme'));

    expect(await screen.findByText('Choose the column with the email addresses.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import .* rows$/ })).toBeDisabled();
  });

  it('refuses a file without rows', async () => {
    const user = userEvent.setup();
    renderWithApp(<CsvImport onClose={vi.fn()} onViewList={vi.fn()} />);

    await upload(user, csvFile('email,first name\n'));

    expect(await screen.findByText(/No rows were found in this file/)).toBeInTheDocument();
  });

  it('keeps what was imported when a later chunk fails, and says how far it got', async () => {
    const user = userEvent.setup();
    const total = REACH_IMPORT_MAX_ROWS + 1;
    const rows = Array.from({ length: total }, (_, index) => `p${index}@c${index}.com`);
    reach.importProspects
      .mockResolvedValueOnce({ data: { listId: 'lst_9', created: REACH_IMPORT_MAX_ROWS, updated: 0, skipped: [] } })
      .mockRejectedValueOnce(new Error('Service unavailable.'));
    renderWithApp(<CsvImport onClose={vi.fn()} onViewList={vi.fn()} />);

    await upload(user, csvFile(['email', ...rows].join('\n')));
    await user.click(await screen.findByRole('button', { name: /^Import .* rows$/ }));

    expect(await screen.findByText(/The import stopped after 5,000 of 5,001 rows \(Service unavailable\)/)).toBeInTheDocument();
    expect(screen.getByText(/Created 5,000/)).toBeInTheDocument();
  });
});
