import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  features: new Set<string>(['books-receipts']),
  documents: [] as unknown[],
  totalCount: 0,
  stats: [] as unknown[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  legacyList: vi.fn(),
  legacyStats: vi.fn(),
  getDocument: vi.fn(),
  createDocument: vi.fn(),
  processDocument: vi.fn(),
  upload: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  search: {} as Record<string, string>,
}));

vi.mock('@/lib/edition', () => ({ isFeatureAvailable: (feature: string) => env.features.has(feature) }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => env.search,
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push, replace: env.replace }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/object-panel', () => ({ useObjectPanelUrlSync: vi.fn() }));
vi.mock('@/components/object-panel/record-link', () => ({
  useRecordLink: () => () => ({ href: '#', onOpen: vi.fn() }),
}));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => ({ uploadFile: (...args: unknown[]) => env.upload(...args) }) }));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({ formatMoney: (value: number) => `€${Number(value).toFixed(2)}` }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: number) => `€${Number(value).toFixed(2)}`, formatDate: (value: string) => value }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-accounting-queries')>()),
  useAccountingBill: () => ({ data: undefined }),
  useAccountingInvoice: () => ({ data: undefined }),
}));
vi.mock('@/hooks/queries/use-weldbooks-receipts-queries', () => ({
  useEntityDocuments: () => ({
    data: { items: env.documents, totalCount: env.totalCount },
    isLoading: false,
    hasNextPage: env.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: env.fetchNextPage,
  }),
  useEntityDocumentStats: () => ({ data: env.stats }),
}));
vi.mock('./inbox-address-card', () => ({ InboxAddressCard: () => <div data-testid="inbox-address" /> }));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: {
    listDocuments: (...args: unknown[]) => env.legacyList(...args),
    getDocumentStats: (...args: unknown[]) => env.legacyStats(...args),
    getDocument: (...args: unknown[]) => env.getDocument(...args),
    createDocument: (...args: unknown[]) => env.createDocument(...args),
    processDocument: (...args: unknown[]) => env.processDocument(...args),
    rejectDocument: vi.fn(),
    deleteDocument: vi.fn(),
    rematchDocument: vi.fn(),
    createCustomer: vi.fn(),
  },
}));
// The list has its own tests: here it hands over its rows and its create button.
vi.mock('@/components/accounting/weldbooks-entity-list', () => ({
  WeldbooksEntityList: ({
    items,
    onRowClick,
    getRowLabel,
    createButton,
  }: {
    items: Array<{ id: string; fileName: string }>;
    onRowClick?: (item: { id: string; fileName: string }) => void;
    getRowLabel?: (item: { id: string; fileName: string }) => string;
    createButton?: { label: string; onClick: () => void };
  }) => (
    <div>
      {createButton ? (
        <button type="button" onClick={createButton.onClick}>
          {createButton.label}
        </button>
      ) : null}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onRowClick?.(item)}>
              {getRowLabel?.(item) ?? item.fileName}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ),
}));

import { renderWithProviders } from '../invoices/components/test-utils';
import DocumentInboxPage from './page';

const toCheck = { id: 'doc_1', fileName: 'paper.pdf', status: 'processed', type: 'invoice', source: 'email', fileKey: 'k/paper.pdf', mimeType: 'application/pdf' };
const booked = { id: 'doc_2', fileName: 'booked.pdf', status: 'linked', type: 'invoice', source: 'upload', fileKey: 'k/booked.pdf', mimeType: 'application/pdf', linkedEntityType: 'bill', linkedEntityId: 'bill_1' };

function dataTransfer(files: File[]) {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    types: ['Files'],
  };
}

beforeEach(() => {
  env.features = new Set(['books-receipts']);
  env.documents = [toCheck, booked];
  env.totalCount = 2;
  env.stats = [];
  env.hasNextPage = false;
  env.search = {};
  for (const fn of [env.fetchNextPage, env.legacyList, env.legacyStats, env.getDocument, env.createDocument, env.processDocument, env.upload, env.push, env.replace]) {
    fn.mockReset();
  }
  env.legacyList.mockResolvedValue({ data: [toCheck, booked] });
  env.legacyStats.mockResolvedValue({ data: [] });
});

describe('the Inbox page with receipts', () => {
  it('shows the inbox address and the real counts of the entity', () => {
    env.stats = [
      { status: 'processed', count: 47 },
      { status: 'linked', count: 310 },
    ];
    renderWithProviders(<DocumentInboxPage />);

    expect(screen.getByTestId('inbox-address')).toBeInTheDocument();
    expect(screen.getByText('47')).toBeInTheDocument();
    expect(screen.getByText('310')).toBeInTheDocument();
    // The paged query, not the old first-100 one.
    expect(env.legacyList).not.toHaveBeenCalled();
    expect(env.legacyStats).not.toHaveBeenCalled();
  });

  it('pages: says how many of the total are shown and loads the next page', async () => {
    const user = userEvent.setup();
    env.totalCount = 120;
    env.hasNextPage = true;
    renderWithProviders(<DocumentInboxPage />);

    expect(screen.getByTestId('inbox-paging')).toHaveTextContent('Showing 2 of 120');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(env.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('offers no Load more on the last page', () => {
    renderWithProviders(<DocumentInboxPage />);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('opens a document still to check on the review screen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DocumentInboxPage />);

    await user.click(screen.getByRole('button', { name: 'paper.pdf' }));

    expect(env.push).toHaveBeenCalledWith('/weldbooks/documents/doc_1/review');
  });

  it('shows a booked document in its dialog, with the bill it became', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DocumentInboxPage />);

    await user.click(screen.getByRole('button', { name: 'booked.pdf' }));

    expect(env.push).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('opens a document linked to from elsewhere on the review screen', async () => {
    env.search = { document: 'doc_1' };
    env.getDocument.mockResolvedValue({ data: toCheck });
    renderWithProviders(<DocumentInboxPage />);

    await waitFor(() => expect(env.replace).toHaveBeenCalledWith('/weldbooks/documents/doc_1/review'));
  });

  it('takes files dropped anywhere on the page and uploads them to the inbox', async () => {
    env.upload.mockResolvedValue({ fileName: 'bon.pdf', fileKey: 'weldbooks/documents/bon.pdf', mimeType: 'application/pdf', fileSize: 12 });
    env.createDocument.mockResolvedValue({ data: { id: 'doc_new' } });
    renderWithProviders(<DocumentInboxPage />);

    const file = new File(['%PDF'], 'bon.pdf', { type: 'application/pdf' });
    fireEvent.drop(screen.getByTestId('inbox-drop-area'), { dataTransfer: dataTransfer([file]) });

    await waitFor(() => expect(env.createDocument).toHaveBeenCalledTimes(1));
    expect(env.upload).toHaveBeenCalledWith(file);
    expect(env.createDocument).toHaveBeenCalledWith({
      fileName: 'bon.pdf',
      fileKey: 'weldbooks/documents/bon.pdf',
      mimeType: 'application/pdf',
      fileSize: 12,
      source: 'upload',
    });
    expect(await screen.findByText('bon.pdf')).toBeInTheDocument();
  });

  it('says a dropped file of another kind cannot be read', async () => {
    renderWithProviders(<DocumentInboxPage />);

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByTestId('inbox-drop-area'), { dataTransfer: dataTransfer([file]) });

    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(env.upload).not.toHaveBeenCalled();
  });

  it('shows the drop overlay while files are dragged over the page', async () => {
    renderWithProviders(<DocumentInboxPage />);

    const area = screen.getByTestId('inbox-drop-area');
    const file = new File(['%PDF'], 'bon.pdf', { type: 'application/pdf' });
    fireEvent.dragEnter(area, { dataTransfer: dataTransfer([file]) });

    expect(await within(area).findByText('Drop to add to your inbox')).toBeInTheDocument();
  });
});

describe('the Inbox page without receipts (Global)', () => {
  beforeEach(() => {
    env.features = new Set();
  });

  it('keeps the first-100 list and the old counts, with no address and no paging', async () => {
    env.legacyStats.mockResolvedValue({ data: [{ status: 'processed', count: 3 }] });
    renderWithProviders(<DocumentInboxPage />);

    await waitFor(() => expect(env.legacyList).toHaveBeenCalled());
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-address')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-paging')).not.toBeInTheDocument();
  });

  it('opens a document in the dialog with the create-bill flow, not the review screen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DocumentInboxPage />);

    await user.click(await screen.findByRole('button', { name: 'paper.pdf' }));

    const dialog = await screen.findByRole('dialog');
    expect(env.push).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: /Create bill|Enter manually|Create bill from document/ })).toBeInTheDocument();
  });

  it('opens a document linked to from elsewhere in the dialog', async () => {
    env.search = { document: 'doc_1' };
    env.getDocument.mockResolvedValue({ data: toCheck });
    renderWithProviders(<DocumentInboxPage />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(env.replace).not.toHaveBeenCalled();
  });
});
