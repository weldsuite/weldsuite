import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FormRenderer } from './FormRenderer';
import { makeDefinition, TEST_LABELS } from './test-utils';
import type { SubmitPayload } from './types';

/** Fills the one field of a form in preview-less live mode and returns the answers it submitted. */
function submitted(block: Record<string, unknown>, fill: () => void): Promise<SubmitPayload['answers']> {
  return new Promise((resolve) => {
    const onSubmit = vi.fn(async (payload: SubmitPayload) => {
      resolve(payload.answers);
      return {
        ending: { id: 'e_done', title: 'Done', description: null, redirectUrl: null, button: null, showScore: false, showAnswers: false },
        score: 0,
        quiz: null,
      };
    });
    render(<FormRenderer labels={TEST_LABELS} mode="live" onSubmit={onSubmit} definition={makeDefinition({ blocks: [block] as never })} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  });
}

describe('field answers', () => {
  it('builds a date answer from day, month and year', async () => {
    const answers = await submitted({ id: 'b_d', ref: 'd', type: 'date', title: 'Birthday', properties: { format: 'DMY' } }, () => {
      fireEvent.change(screen.getByPlaceholderText('DD'), { target: { value: '7' } });
      fireEvent.change(screen.getByPlaceholderText('MM'), { target: { value: '3' } });
      fireEvent.change(screen.getByPlaceholderText('YYYY'), { target: { value: '1990' } });
    });
    expect(answers).toEqual({ b_d: '1990-03-07' });
  });

  it('flags an incomplete date as invalid, not missing', () => {
    render(
      <FormRenderer
        labels={TEST_LABELS}
        mode="preview"
        definition={makeDefinition({ blocks: [{ id: 'b_d', ref: 'd', type: 'date', title: 'Birthday' }] })}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('DD'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByRole('alert').textContent).toBe('Invalid date');
  });

  it('searches a dropdown and picks with the keyboard', async () => {
    const answers = await submitted(
      {
        id: 'b_dd',
        ref: 'dd',
        type: 'dropdown',
        title: 'Country',
        properties: { choices: [{ id: 'c_nl', label: 'Netherlands' }, { id: 'c_be', label: 'Belgium' }, { id: 'c_de', label: 'Germany' }] },
      },
      () => {
        const box = screen.getByRole('combobox');
        fireEvent.focus(box);
        fireEvent.change(box, { target: { value: 'bel' } });
        expect(screen.getAllByRole('option')).toHaveLength(1);
        fireEvent.keyDown(box, { key: 'Enter' });
      },
    );
    expect(answers).toEqual({ b_dd: { choiceIds: ['c_be'] } });
  });

  it('takes an Other answer', async () => {
    const answers = await submitted(
      {
        id: 'b_mc',
        ref: 'mc',
        type: 'multiple_choice',
        title: 'Pick',
        properties: { choices: [{ id: 'c_a', label: 'A-option' }], allowOther: true },
      },
      () => {
        fireEvent.click(screen.getByRole('radio', { name: /Other/ }));
        fireEvent.change(screen.getByPlaceholderText('Type your answer'), { target: { value: 'Mauve' } });
      },
    );
    expect(answers).toEqual({ b_mc: { choiceIds: [], other: 'Mauve' } });
  });

  it('reorders a ranking with the buttons', async () => {
    const answers = await submitted(
      {
        id: 'b_r',
        ref: 'r',
        type: 'ranking',
        title: 'Rank',
        properties: { choices: [{ id: 'c_1', label: 'One' }, { id: 'c_2', label: 'Two' }] },
      },
      () => {
        fireEvent.click(screen.getByRole('button', { name: 'Move Two up' }));
      },
    );
    expect(answers).toEqual({ b_r: ['c_2', 'c_1'] });
  });

  it('answers a matrix row', async () => {
    const answers = await submitted(
      {
        id: 'b_m',
        ref: 'm',
        type: 'matrix',
        title: 'Rate',
        properties: {
          rows: [{ id: 'r_1', label: 'Speed' }],
          columns: [{ id: 'k_1', label: 'Bad' }, { id: 'k_2', label: 'Good' }],
        },
      },
      () => {
        fireEvent.click(screen.getByRole('radio', { name: 'Speed: Good' }));
      },
    );
    expect(answers).toEqual({ b_m: { r_1: ['k_2'] } });
  });

  it('keeps a number as typed and reports junk as invalid', () => {
    render(
      <FormRenderer
        labels={TEST_LABELS}
        mode="preview"
        definition={makeDefinition({ blocks: [{ id: 'b_n', ref: 'n', type: 'number', title: 'How many', properties: { decimals: 2 } }] })}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12.' } });
    expect(input.value).toBe('12.');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByRole('alert').textContent).toBe('Invalid answer');
  });
});
