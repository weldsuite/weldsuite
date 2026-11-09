import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormRenderer } from './FormRenderer';
import { ageBlock, colorBlock, makeDefinition, nameBlock, TEST_LABELS, yesNoBlock } from './test-utils';
import type { FormRendererProps } from './types';

function renderForm(props: Partial<FormRendererProps> & Pick<FormRendererProps, 'definition'>) {
  return render(<FormRenderer labels={TEST_LABELS} mode="preview" {...props} />);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('conversational layout', () => {
  // yes -> skip "age" and go to the last question
  const jumping = makeDefinition({
    blocks: [yesNoBlock, ageBlock, nameBlock],
    logic: [
      {
        blockId: 'b_yes',
        jumps: [
          {
            id: 'j_1',
            when: { op: 'and', conditions: [{ left: { type: 'field', id: 'b_yes' }, operator: 'is', right: { type: 'constant', value: true } }] },
            to: { type: 'block', id: 'b_name' },
          },
        ],
      },
    ],
  });

  it('follows a jump and skips the block in between', () => {
    renderForm({ definition: jumping });
    expect(screen.getByRole('heading', { name: /Do you like forms/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Yes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('heading', { name: /Your name/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Your age/ })).toBeNull();
  });

  it('takes the normal route when the jump does not apply', () => {
    renderForm({ definition: jumping });
    fireEvent.click(screen.getByRole('radio', { name: /No/ }));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('heading', { name: /Your age/ })).toBeTruthy();
  });

  it('shows a required error and stays on the step', () => {
    renderForm({ definition: makeDefinition({ blocks: [nameBlock] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByRole('alert').textContent).toBe('This field is required');
    expect(screen.getByRole('heading', { name: /Your name/ })).toBeTruthy();
    // typing clears the error
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ada' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('picks a choice with its letter key', () => {
    renderForm({ definition: makeDefinition({ blocks: [colorBlock] }) });
    fireEvent.keyDown(document.body, { key: 'b' });
    expect(screen.getByRole('checkbox', { name: /Green/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(screen.getByRole('checkbox', { name: /Red/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'b' });
    expect(screen.getByRole('checkbox', { name: /Green/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('moves on with Enter and goes back', () => {
    renderForm({ definition: makeDefinition({ blocks: [nameBlock, ageBlock] }) });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ada' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(screen.getByRole('heading', { name: /Your age/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: /Your name/ })).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Ada');
  });

  it('auto-advances after a single choice', () => {
    vi.useFakeTimers();
    renderForm({ definition: makeDefinition({ blocks: [yesNoBlock, ageBlock] }) });
    fireEvent.keyDown(document.body, { key: 'y' });
    expect(screen.getByRole('radio', { name: /Yes/ }).getAttribute('aria-checked')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('heading', { name: /Your age/ })).toBeTruthy();
  });

  it('picks a scale value with a number key', () => {
    const def = makeDefinition({
      blocks: [{ id: 'b_nps', ref: 'nps', type: 'nps', title: 'How likely?' }, ageBlock],
    });
    renderForm({ definition: def });
    fireEvent.keyDown(document.body, { key: '7' });
    expect(screen.getByRole('radio', { name: '7' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the welcome screen first', () => {
    const def = makeDefinition({ blocks: [nameBlock], welcome: { title: 'Hello there', buttonText: 'Go' } });
    renderForm({ definition: def });
    expect(screen.getByRole('heading', { name: 'Hello there' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByRole('heading', { name: /Your name/ })).toBeTruthy();
  });

  it('shows progress along the path', () => {
    renderForm({ definition: makeDefinition({ blocks: [nameBlock, ageBlock] }) });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('0% completed')).toBeTruthy();
  });
});

describe('preview ending', () => {
  it('shows the ending computed locally, with recall and score', () => {
    const def = makeDefinition({
      blocks: [
        nameBlock,
        {
          id: 'b_quiz',
          ref: 'quiz',
          type: 'multiple_choice',
          title: 'Capital of France?',
          properties: {
            choices: [
              { id: 'c_p', label: 'Paris', score: 1, correct: true },
              { id: 'c_l', label: 'Lyon', score: 0 },
            ],
          },
        },
      ],
      endings: [{ id: 'e_done', ref: 'done', title: 'Thanks {{field:name}}', showScore: true, showAnswers: true }],
    });
    renderForm({ definition: def });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('radio', { name: /Lyon/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByRole('heading', { name: 'Thanks Ada' })).toBeTruthy();
    expect(screen.getByText('Your score: 0')).toBeTruthy();
    expect(screen.getByText(/Correct answer: Paris/)).toBeTruthy();
  });

  it('does not call the server in preview', () => {
    const onSubmit = vi.fn();
    renderForm({ definition: makeDefinition({ blocks: [ageBlock] }), onSubmit });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Thanks/ })).toBeTruthy();
  });
});

describe('live submit', () => {
  it('sends the answers on the path and shows the server ending', async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      ending: { id: 'e_done', title: 'Server says thanks', description: null, redirectUrl: null, button: null, showScore: false, showAnswers: false },
      score: 0,
      quiz: null,
    });
    const onEnding = vi.fn();
    renderForm({ definition: makeDefinition({ blocks: [nameBlock] }), mode: 'live', onSubmit, onEnding });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Server says thanks' })).toBeTruthy());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0].answers).toEqual({ b_name: 'Ada' });
    expect(onEnding).toHaveBeenCalledTimes(1);
  });

  it('jumps to the first field the server refused', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ fieldErrors: { b_name: { code: 'too_long' } } });
    const def = makeDefinition({ blocks: [{ ...nameBlock, properties: { maxLength: 5 } }, ageBlock] });
    renderForm({ definition: def, mode: 'live', onSubmit, initialAnswers: { b_name: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('heading', { name: /Your age/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Max 5 characters'));
    expect(screen.getByRole('heading', { name: /Your name/ })).toBeTruthy();
  });

  it('reports progress per step', () => {
    const onProgress = vi.fn();
    renderForm({ definition: makeDefinition({ blocks: [nameBlock, ageBlock] }), mode: 'live', onSubmit: vi.fn(), onProgress });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0]?.[0].lastBlockId).toBe('b_age');
    expect(onProgress.mock.calls[0]?.[0].answers).toEqual({ b_name: 'Ada' });
  });

  it('uploads a file and keeps the returned item as the answer', async () => {
    const onUpload = vi.fn().mockResolvedValue({ fileId: 'f_1', name: 'cv.pdf', size: 3, type: 'application/pdf' });
    const def = makeDefinition({ blocks: [{ id: 'b_file', ref: 'cv', type: 'file_upload', title: 'Your CV', required: true }] });
    const { container } = renderForm({ definition: def, mode: 'live', onSubmit: vi.fn(), onUpload });
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['abc'], 'cv.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(screen.getByText('cv.pdf')).toBeTruthy());
    expect(onUpload).toHaveBeenCalledWith('b_file', expect.any(File), expect.any(Function));
  });
});

describe('classic layout', () => {
  const classic = makeDefinition({
    presentation: { layout: 'classic' },
    blocks: [yesNoBlock, ageBlock, nameBlock],
    logic: [
      {
        blockId: 'b_yes',
        jumps: [
          {
            id: 'j_1',
            when: { op: 'and', conditions: [{ left: { type: 'field', id: 'b_yes' }, operator: 'is', right: { type: 'constant', value: false } }] },
            to: { type: 'block', id: 'b_name' },
          },
        ],
      },
    ],
  });

  it('shows every question on a page and hides the skipped ones live', () => {
    renderForm({ definition: classic });
    expect(screen.getByRole('heading', { name: /Your age/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Your name/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /No/ }));
    expect(screen.queryByRole('heading', { name: /Your age/ })).toBeNull();
    expect(screen.getByRole('heading', { name: /Your name/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Yes/ }));
    expect(screen.getByRole('heading', { name: /Your age/ })).toBeTruthy();
  });

  it('splits pages at a page break and validates per page', () => {
    const def = makeDefinition({
      presentation: { layout: 'classic' },
      blocks: [nameBlock, { id: 'b_pb', ref: 'pb', type: 'page_break' }, ageBlock],
    });
    renderForm({ definition: def });
    expect(screen.queryByRole('heading', { name: /Your age/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Fix the errors')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: /Your age/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
  });
});
