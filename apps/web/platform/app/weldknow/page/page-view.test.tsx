import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import PageView from './page-view';

type Page = {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverImage: string | null;
  isLocked: boolean;
  contentJson: unknown[];
};

let page: Page;
const updateMetaMutate = vi.fn();
const fakeEditor = {
  document: [] as { id: string; type: string; content: unknown[] }[],
  setTextCursorPosition: vi.fn(),
  insertBlocks: vi.fn(),
  focus: vi.fn(),
};

vi.mock('@weldsuite/permissions/react', () => ({
  useCan: () => true,
}));

vi.mock('@/contexts/breadcrumb-context', () => ({
  useBreadcrumbs: () => undefined,
}));

vi.mock('@/components/page-loader', () => ({
  PageLoader: () => <div>loading</div>,
}));

vi.mock('@/components/block-editor/block-editor', () => ({
  BlockEditor: ({ onEditorReady }: { onEditorReady: (editor: unknown) => void }) => {
    onEditorReady(fakeEditor);
    return <div data-testid="block-editor" />;
  },
}));

vi.mock('@/components/block-editor/heading-outline', () => ({
  HeadingOutline: () => null,
}));

vi.mock('@/hooks/queries/use-knowledge-queries', () => ({
  useKnowledgePage: () => ({ data: { data: page }, isLoading: false, isError: false }),
  useKnowledgePageTree: () => ({ data: { data: [] } }),
  useKnowledgeSpaces: () => ({
    data: { data: [{ id: 'ks_1', canWrite: true, isMember: true, kind: 'team', visibility: 'open' }] },
  }),
  useUpdateKnowledgePageMeta: () => ({ mutate: updateMetaMutate }),
  useJoinKnowledgeSpace: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveKnowledgePageContent: () => ({ mutate: vi.fn() }),
  useCreateKnowledgePage: () => ({ mutateAsync: vi.fn() }),
}));

function titleField() {
  return screen.getByPlaceholderText(en.weldknow.page.titlePlaceholder) as HTMLTextAreaElement;
}

describe('WeldKnow page title', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = {
      id: 'kpag_1',
      spaceId: 'ks_1',
      parentId: null,
      title: 'Untitled',
      icon: null,
      coverImage: null,
      isLocked: false,
      contentJson: [],
    };
    fakeEditor.document = [{ id: 'blk_1', type: 'paragraph', content: [] }];
    fakeEditor.insertBlocks.mockReturnValue([{ id: 'blk_new', type: 'paragraph', content: [] }]);
  });

  it('shows the default title as an empty, focused field', () => {
    render(<PageView pageId="kpag_1" />);

    expect(titleField().value).toBe('');
    expect(document.activeElement).toBe(titleField());
  });

  it('treats the translated placeholder saved by older clients as no title', () => {
    page.title = en.weldknow.page.untitled;
    render(<PageView pageId="kpag_1" />);

    expect(titleField().value).toBe('');
  });

  it('keeps a real title and does not steal focus', () => {
    page.title = 'Onboarding Guide';
    render(<PageView pageId="kpag_1" />);

    expect(titleField().value).toBe('Onboarding Guide');
    expect(document.activeElement).not.toBe(titleField());
  });

  it('typed text replaces the default instead of landing inside it', () => {
    render(<PageView pageId="kpag_1" />);
    fireEvent.change(titleField(), { target: { value: 'Day One' } });
    fireEvent.blur(titleField());

    expect(updateMetaMutate).toHaveBeenCalledWith(
      { id: 'kpag_1', data: { title: 'Day One' } },
      expect.anything(),
    );
  });

  it('clearing a title saves the untranslated default, not the locale placeholder', () => {
    page.title = 'Onboarding Guide';
    render(<PageView pageId="kpag_1" />);
    fireEvent.change(titleField(), { target: { value: '   ' } });
    fireEvent.blur(titleField());

    expect(updateMetaMutate).toHaveBeenCalledWith(
      { id: 'kpag_1', data: { title: 'Untitled' } },
      expect.anything(),
    );
  });

  it('saves nothing when the title is left unchanged', () => {
    render(<PageView pageId="kpag_1" />);
    fireEvent.blur(titleField());

    expect(updateMetaMutate).not.toHaveBeenCalled();
  });

  it('turns a pasted line break into a space', () => {
    render(<PageView pageId="kpag_1" />);
    fireEvent.change(titleField(), { target: { value: 'Line one\nline two' } });

    expect(titleField().value).toBe('Line one line two');
  });

  it('Enter saves the title and moves the caret into an empty first block', () => {
    render(<PageView pageId="kpag_1" />);
    fireEvent.change(titleField(), { target: { value: 'Onboarding Guide' } });
    fireEvent.keyDown(titleField(), { key: 'Enter' });

    expect(updateMetaMutate).toHaveBeenCalledWith(
      { id: 'kpag_1', data: { title: 'Onboarding Guide' } },
      expect.anything(),
    );
    expect(fakeEditor.setTextCursorPosition).toHaveBeenCalledWith(fakeEditor.document[0], 'start');
    expect(fakeEditor.insertBlocks).not.toHaveBeenCalled();
    expect(fakeEditor.focus).toHaveBeenCalled();
    expect(titleField().value).toBe('Onboarding Guide');
  });

  it('Enter opens a new paragraph above existing body content', () => {
    fakeEditor.document = [{ id: 'blk_1', type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }];
    page.title = 'Onboarding Guide';
    render(<PageView pageId="kpag_1" />);
    fireEvent.keyDown(titleField(), { key: 'Enter' });

    expect(fakeEditor.insertBlocks).toHaveBeenCalledWith([{ type: 'paragraph' }], fakeEditor.document[0], 'before');
    expect(fakeEditor.setTextCursorPosition).toHaveBeenCalledWith({ id: 'blk_new', type: 'paragraph', content: [] }, 'start');
    expect(fakeEditor.focus).toHaveBeenCalled();
  });

  it('a locked page neither focuses nor edits the title', () => {
    page.isLocked = true;
    render(<PageView pageId="kpag_1" />);

    expect(titleField().disabled).toBe(true);
    expect(document.activeElement).not.toBe(titleField());
  });
});
