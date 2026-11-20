import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement, Ref } from 'react';
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

vi.mock('@weldsuite/ui/components/page-loader', () => ({
  PageLoader: () => <div>loading</div>,
}));

// What the editor would do on a load from the server, and how it reports a local edit.
const replaceContent = vi.fn();
let editBody: ((blocks: unknown[]) => void) | undefined;

vi.mock('@/components/block-editor/block-editor', () => ({
  BlockEditor: ({
    onEditorReady,
    onContentChange,
    ref,
  }: {
    onEditorReady: (editor: unknown) => void;
    onContentChange?: (blocks: unknown[]) => void;
    ref?: Ref<{ replaceContent: typeof replaceContent }>;
  }) => {
    onEditorReady(fakeEditor);
    editBody = onContentChange;
    if (ref && typeof ref === 'object') ref.current = { replaceContent };
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

  it('shows a rename made from the sidebar without a reload', () => {
    page.title = 'Onboarding Guide';
    const { rerender } = render(<PageView pageId="kpag_1" />);
    page = { ...page, title: 'Day One' };
    rerender(<PageView pageId="kpag_1" />);

    expect(titleField().value).toBe('Day One');
    // The rename is now the saved title: leaving the field saves nothing over it.
    fireEvent.blur(titleField());
    expect(updateMetaMutate).not.toHaveBeenCalled();
  });

  it('shows a teammate naming a new page while its empty title has the caret', () => {
    const { rerender } = render(<PageView pageId="kpag_1" />);
    expect(document.activeElement).toBe(titleField());
    page = { ...page, title: 'Day One' };
    rerender(<PageView pageId="kpag_1" />);

    expect(titleField().value).toBe('Day One');
    fireEvent.blur(titleField());
    expect(updateMetaMutate).not.toHaveBeenCalled();
  });

  it('keeps a title being typed when the stored title changes underneath it', () => {
    page.title = 'Onboarding Guide';
    const { rerender } = render(<PageView pageId="kpag_1" />);
    titleField().focus();
    fireEvent.change(titleField(), { target: { value: 'Onboarding Guide v2' } });
    page = { ...page, title: 'Day One' };
    rerender(<PageView pageId="kpag_1" />);

    expect(titleField().value).toBe('Onboarding Guide v2');
  });

  it('a locked page neither focuses nor edits the title', () => {
    page.isLocked = true;
    render(<PageView pageId="kpag_1" />);

    expect(titleField().disabled).toBe(true);
    expect(document.activeElement).not.toBe(titleField());
  });
});

describe('WeldKnow page body sync', () => {
  const body = (text: string) => [{ id: 'blk_1', type: 'paragraph', content: [{ type: 'text', text }] }];

  /** A local edit, saved once the autosave delay has passed. */
  function editAndSave(text: string) {
    act(() => {
      editBody?.(body(text));
      vi.advanceTimersByTime(1500);
    });
  }

  /** The page as the server now has it, as a realtime refetch delivers it. */
  function serverHas(text: string, rerender: (ui: ReactElement) => void) {
    page = { ...page, contentJson: body(text) };
    rerender(<PageView pageId="kpag_1" />);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    page = {
      id: 'kpag_1',
      spaceId: 'ks_1',
      parentId: null,
      title: 'Onboarding Guide',
      icon: null,
      coverImage: null,
      isLocked: false,
      contentJson: body('Hello'),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not reload its own save when it echoes back', () => {
    const { rerender } = render(<PageView pageId="kpag_1" />);
    editAndSave('Hello mine');
    serverHas('Hello mine', rerender);

    expect(replaceContent).not.toHaveBeenCalled();
  });

  it('loads an edit made elsewhere', () => {
    const { rerender } = render(<PageView pageId="kpag_1" />);
    serverHas('Hello theirs', rerender);

    expect(replaceContent).toHaveBeenCalledWith(body('Hello theirs'));
  });

  it('loads its own earlier save when that reaches the server after an edit made elsewhere', () => {
    const { rerender } = render(<PageView pageId="kpag_1" />);
    editAndSave('Mine');
    serverHas('Theirs', rerender);
    expect(replaceContent).toHaveBeenLastCalledWith(body('Theirs'));

    // Our save landed last, so the server holds it: the editor must show it, not stay on theirs.
    serverHas('Mine', rerender);
    expect(replaceContent).toHaveBeenLastCalledWith(body('Mine'));
    expect(replaceContent).toHaveBeenCalledTimes(2);
  });
});
