import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const search = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock('@/hooks/queries/use-global-search-queries', () => ({
  useGlobalSearch: (q: string, opts: { enabled?: boolean }) => {
    if (opts.enabled) search.queries.push(q);
    return {
      isFetching: false,
      data: {
        data: q
          ? [
              { type: 'customer', items: [{ id: 'cmp_1', title: 'Budget Co' }] },
              { type: 'sheet', items: [{ id: 'sht_1', title: 'Budget 2026' }] },
            ]
          : [],
      },
    };
  },
}));
vi.mock('@/lib/search/result-types', () => ({
  RESULT_TYPE_ICON: {},
  RESULT_TYPE_LABEL: { sheet: 'Spreadsheets', customer: 'Companies' },
}));
vi.mock('@/lib/i18n', () => ({
  getTranslations: () => ({
    ai: {
      chat: {
        placeholder: 'Ask WeldAgent anything…',
        send: 'Send',
        mentions: { label: 'Tag a record', hint: 'Type to tag', searching: 'Searching…', noResults: 'Nothing matches "{query}"' },
      },
    },
  }),
}));

import { AgentChatInput, AgentComposer } from './agent-chat-input';

function setup(variant?: 'inline' | 'stacked') {
  const onSubmit = vi.fn();
  function Harness() {
    const [value, setValue] = useState('');
    return (
      <AgentChatInput
        value={value}
        onChange={setValue}
        onSubmit={(text) => {
          onSubmit(text);
          setValue('');
        }}
        variant={variant}
      />
    );
  }
  const ui = render(<Harness />);
  const textarea = ui.getByPlaceholderText('Ask WeldAgent anything…') as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(textarea, { target: { value } });
  return { ...ui, textarea, type, onSubmit };
}

afterEach(() => {
  cleanup();
  search.queries.length = 0;
});

describe('tagging a record in the WeldAgent composer', () => {
  it('offers matching records for @query, spreadsheets first', () => {
    const { type, getAllByRole } = setup();
    type('Fill @bud');
    expect(search.queries.at(-1)).toBe('bud');
    expect(getAllByRole('option').map((o) => o.textContent)).toEqual(['Budget 2026Spreadsheets', 'Budget CoCompanies']);
  });

  it('shows @Name in the text and sends the record token', () => {
    const { textarea, type, onSubmit, queryByTestId } = setup();
    type('Fill @bud');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('Fill @Budget 2026 ');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(queryByTestId('record-tag-menu')).toBeNull();

    type('Fill @Budget 2026 with totals');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('Fill <@sheet:sht_1|Budget 2026> with totals');
  });

  it('closes on Escape without sending, and Enter then sends the text as typed', () => {
    const { textarea, type, onSubmit, queryByTestId } = setup();
    type('mail @bud');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(queryByTestId('record-tag-menu')).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('mail @bud');
  });

  it('does not open for an e-mail address', () => {
    const { type, queryByTestId } = setup();
    type('send it to ann@acme.com');
    expect(queryByTestId('record-tag-menu')).toBeNull();
  });

  it('opens from the + button of the stacked composer, after a space', async () => {
    const { textarea, type, getByRole, findByTestId } = setup('stacked');
    type('Fill');
    fireEvent.click(getByRole('button', { name: 'Tag a record' }));
    expect(textarea.value).toBe('Fill @');
    expect(await findByTestId('record-tag-menu')).toBeTruthy();
  });
});

describe('AgentComposer', () => {
  function composer(props: { disabled?: boolean } = {}) {
    const onSubmit = vi.fn();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <AgentComposer
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          suggestions={['Show my open tasks', 'Find a contact']}
          {...props}
        />
      );
    }
    const ui = render(<Harness />);
    const textarea = ui.getByPlaceholderText('Ask WeldAgent anything…') as HTMLTextAreaElement;
    return { ...ui, textarea, onSubmit };
  }

  it('sends a suggestion picked above the input', () => {
    const { getByRole, onSubmit } = composer();
    fireEvent.click(getByRole('button', { name: 'Find a contact' }));
    expect(onSubmit).toHaveBeenCalledWith('Find a contact');
  });

  it('hides the suggestions once something is typed', () => {
    const { textarea, queryByRole } = composer();
    fireEvent.change(textarea, { target: { value: 'Hi' } });
    expect(queryByRole('button', { name: 'Show my open tasks' })).toBeNull();
  });

  it('turns the suggestions off with the input', () => {
    const { getByRole } = composer({ disabled: true });
    expect((getByRole('button', { name: 'Show my open tasks' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
