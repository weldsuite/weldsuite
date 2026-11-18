import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { createBlankDefinition, createField, createPageBreak, type FormDefinition } from '@weldsuite/forms-engine';
import { FlowDiagram } from './flow-diagram';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

const q1 = createField('short_text', { ref: 'q1', title: 'Your name' });
const q2 = createField('email', { ref: 'q2', title: 'Your email' });
const base = createBlankDefinition();
const second = { ...base.endings[0]!, id: 'e_two', ref: 'two', title: 'Second ending' };

function definition(extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    ...base,
    blocks: [q1, createPageBreak({ ref: 'pb' }), q2],
    endings: [{ ...base.endings[0]!, title: 'Thanks' }, second],
    logic: [
      {
        blockId: q1.id,
        calculations: [],
        jumps: [{ id: 'j_1', when: { op: 'and', conditions: [{ left: { type: 'field', id: q1.id }, operator: 'is_answered' }] }, to: { type: 'block', id: q2.id } }],
        otherwise: { type: 'ending', id: second.id },
      },
    ],
    endingRules: [{ id: 'r_1', when: { op: 'and', conditions: [{ left: { type: 'variable', name: 'score' }, operator: 'is_answered' }] }, endingId: second.id }],
    ...extra,
  };
}

describe('FlowDiagram', () => {
  it('draws the start, question and ending cards with type labels and rule summaries', () => {
    render(<FlowDiagram definition={definition()} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText(en.weldforms.logic.startTitle)).toBeTruthy();
    expect(screen.getByText(en.weldforms.logic.start)).toBeTruthy();
    expect(screen.getByText('1. Your name')).toBeTruthy();
    expect(screen.getByText('2. Your email')).toBeTruthy();
    expect(screen.getByText('Thanks')).toBeTruthy();
    expect(screen.getByText('Second ending')).toBeTruthy();
    expect(screen.getAllByText(en.weldforms.properties.ending)).toHaveLength(2);
    expect(screen.getByText(en.weldforms.properties.logicCount.replace('{count}', '2'))).toBeTruthy();
    expect(screen.getByText(en.weldforms.properties.noLogic)).toBeTruthy();
  });

  it('shows the welcome title on the start card and labels untitled blocks', () => {
    const untitled = createField('short_text', { ref: 'q3', title: '' });
    const def = definition({ blocks: [untitled], logic: [], endingRules: [], welcome: { ...base.welcome, title: 'Hello there' } as FormDefinition['welcome'] });
    render(<FlowDiagram definition={def} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText('Hello there')).toBeTruthy();
    expect(screen.getByText(`1. ${en.weldforms.outline.untitled}`)).toBeTruthy();
  });

  it('calls onSelect with the block kind for a question card', () => {
    const onSelect = vi.fn();
    render(<FlowDiagram definition={definition()} selectedId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('1. Your name'));
    expect(onSelect).toHaveBeenCalledWith(q1.id, 'block');
  });

  it('calls onSelect with the ending kind for an ending card', () => {
    const onSelect = vi.fn();
    render(<FlowDiagram definition={definition()} selectedId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Second ending'));
    expect(onSelect).toHaveBeenCalledWith(second.id, 'ending');
  });

  it('does not select the start card', () => {
    const onSelect = vi.fn();
    render(<FlowDiagram definition={definition()} selectedId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByText(en.weldforms.logic.startTitle));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks the selected card', () => {
    const { container, rerender } = render(<FlowDiagram definition={definition()} selectedId={null} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.ring-blue-500\\/15')).toHaveLength(0);

    rerender(<FlowDiagram definition={definition()} selectedId={q2.id} onSelect={vi.fn()} />);
    const selected = container.querySelectorAll('.ring-blue-500\\/15');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('2. Your email');
  });

  it('shows the notice over the canvas', () => {
    render(<FlowDiagram definition={definition()} selectedId={null} onSelect={vi.fn()} notice={<p>read only notice</p>} />);
    expect(screen.getByText('read only notice')).toBeTruthy();
  });

  it('renders connectors for the order, jumps and endings', () => {
    const { container } = render(<FlowDiagram definition={definition()} selectedId={null} onSelect={vi.fn()} />);
    expect(container.querySelector('.react-flow')).toBeTruthy();
  });
});
