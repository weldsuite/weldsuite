import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { createBlankDefinition, createField, createPageBreak, type FormDefinition } from '@weldsuite/forms-engine';
import LogicTab from './page';

const tl = en.weldforms.logic;

let search: Record<string, unknown> = {};
let definition: FormDefinition;
let canEdit = true;
const navigate = vi.fn();
const editDefinition = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

vi.mock('../editor-context', () => ({
  useFormEditor: () => ({ definition, canEdit, editDefinition }),
}));

const q1 = createField('short_text', { ref: 'q1', title: 'Your name' });
const q2 = createField('email', { ref: 'q2', title: 'Your email' });
const base = createBlankDefinition();
const second = { ...base.endings[0]!, id: 'e_two', ref: 'two', title: 'Second ending' };

function withBlocks(extra: Partial<FormDefinition> = {}): FormDefinition {
  return { ...base, blocks: [q1, createPageBreak({ ref: 'pb' }), q2], ...extra };
}

/** Runs the recipe the last editDefinition call received against the current definition. */
function lastEdit(): FormDefinition {
  const recipe = editDefinition.mock.calls.at(-1)?.[0] as (d: FormDefinition) => FormDefinition;
  return recipe(definition);
}

/** The search the last navigate call would produce from the given previous search. */
function navigatedSearch(prev: Record<string, unknown>): Record<string, unknown> {
  const call = navigate.mock.calls.at(-1)?.[0] as { replace: boolean; to: string; search: (p: Record<string, unknown>) => Record<string, unknown> };
  expect(call.replace).toBe(true);
  expect(call.to).toBe('.');
  return call.search(prev);
}

describe('LogicTab', () => {
  beforeEach(() => {
    search = {};
    canEdit = true;
    definition = withBlocks({ endings: [{ ...base.endings[0]!, title: 'Thanks' }, second] });
    navigate.mockClear();
    editDefinition.mockClear();
  });

  it('shows the empty state when the form has no questions', () => {
    definition = { ...base, blocks: [createPageBreak({ ref: 'pb' })] };
    render(<LogicTab />);

    expect(screen.getByText(tl.emptyTitle)).toBeTruthy();
    expect(screen.getByText(tl.emptyDescription)).toBeTruthy();
  });

  it('shows only the flow without a block in the URL', () => {
    render(<LogicTab />);

    expect(screen.getByText('1. Your name')).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('opens the rules of a block with its title and help', () => {
    search = { block: q1.id };
    render(<LogicTab />);

    const panel = screen.getByRole('complementary', { name: tl.rules });
    expect(panel.querySelector('h2')?.textContent).toBe('Your name');
    expect(screen.getByText(tl.blockHelp)).toBeTruthy();
    expect(screen.getByText(tl.noCalculations)).toBeTruthy();
    expect(screen.getByText(tl.noJumps)).toBeTruthy();
  });

  it('falls back to the untitled label for a block without a title', () => {
    const untitled = createField('short_text', { ref: 'q3', title: '' });
    definition = { ...base, blocks: [untitled] };
    search = { block: untitled.id };
    render(<LogicTab />);

    expect(screen.getByRole('complementary').querySelector('h2')?.textContent).toBe(en.weldforms.outline.untitled);
  });

  it('adds a calculation from the panel', () => {
    search = { block: q1.id };
    render(<LogicTab />);

    fireEvent.click(screen.getByRole('button', { name: tl.addCalculation }));
    expect(editDefinition).toHaveBeenCalledTimes(1);
    const next = lastEdit();
    expect(next.logic.find((l) => l.blockId === q1.id)?.calculations).toHaveLength(1);
  });

  it('adds a jump from the panel', () => {
    search = { block: q1.id };
    render(<LogicTab />);

    fireEvent.click(screen.getByRole('button', { name: tl.addJump }));
    const jumps = lastEdit().logic.find((l) => l.blockId === q1.id)?.jumps ?? [];
    expect(jumps).toHaveLength(1);
    expect(jumps[0]?.to.type).toBe('block');
  });

  it('lists existing calculations and jumps, and edits them', () => {
    definition = withBlocks({
      endings: [base.endings[0]!, second],
      logic: [
        {
          blockId: q1.id,
          calculations: [{ id: 'c_1', when: null, variable: 'score', op: 'add', value: { type: 'constant', value: 1 } }],
          jumps: [
            { id: 'j_1', when: { op: 'and', conditions: [{ left: { type: 'field', id: q1.id }, operator: 'is_answered' }] }, to: { type: 'block', id: q2.id } },
            { id: 'j_2', when: { op: 'and', conditions: [{ left: { type: 'field', id: q1.id }, operator: 'is_answered' }] }, to: { type: 'ending', id: second.id } },
          ],
          otherwise: { type: 'ending', id: second.id },
        },
      ],
    });
    search = { block: q1.id };
    render(<LogicTab />);

    expect(screen.queryByText(tl.noCalculations)).toBeNull();
    expect(screen.queryByText(tl.noJumps)).toBeNull();
    expect(screen.getByText(tl.makeConditional)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: tl.makeConditional }));
    expect(lastEdit().logic[0]?.calculations[0]?.when).not.toBeNull();

    const removes = screen.getAllByRole('button', { name: en.common.actions.remove });
    // calculation remove first, then the two jumps' removes
    fireEvent.click(removes[0]!);
    expect(lastEdit().logic[0]?.calculations).toHaveLength(0);
    fireEvent.click(removes[1]!);
    expect(lastEdit().logic[0]?.jumps.map((j) => j.id)).toEqual(['j_2']);

    const ups = screen.getAllByRole('button', { name: tl.moveUp }) as HTMLButtonElement[];
    const downs = screen.getAllByRole('button', { name: tl.moveDown }) as HTMLButtonElement[];
    expect(ups[0]?.disabled).toBe(true);
    expect(downs[1]?.disabled).toBe(true);
    fireEvent.click(downs[0]!);
    expect(lastEdit().logic[0]?.jumps.map((j) => j.id)).toEqual(['j_2', 'j_1']);
    fireEvent.click(ups[1]!);
    expect(lastEdit().logic[0]?.jumps.map((j) => j.id)).toEqual(['j_2', 'j_1']);
  });

  it('shows a conditional calculation with an always button', () => {
    definition = withBlocks({
      logic: [
        {
          blockId: q1.id,
          calculations: [
            { id: 'c_1', when: { op: 'and', conditions: [{ left: { type: 'field', id: q1.id }, operator: 'is_answered' }] }, variable: 'gone', op: 'subtract', value: { type: 'constant', value: 2 } },
          ],
          jumps: [],
          otherwise: null,
        },
      ],
    });
    search = { block: q1.id };
    render(<LogicTab />);

    expect(screen.getByText(tl.onlyIf)).toBeTruthy();
    expect(screen.getByText(tl.calcFrom)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: tl.always }));
    expect(lastEdit().logic[0]?.calculations[0]?.when).toBeNull();
  });

  it('offers the otherwise route select', () => {
    search = { block: q1.id };
    render(<LogicTab />);

    expect(screen.getByRole('combobox', { name: tl.otherwise })).toBeTruthy();
    expect(screen.getByText(tl.otherwise)).toBeTruthy();
  });

  it('opens the ending rules for endings and adds a rule', () => {
    search = { block: 'endings' };
    render(<LogicTab />);

    const panel = screen.getByRole('complementary', { name: tl.rules });
    expect(panel.querySelector('h2')?.textContent).toBe(tl.endingRules);
    expect(screen.getByText(tl.endingRulesHelp)).toBeTruthy();
    expect(screen.getByText(tl.noEndingRules)).toBeTruthy();
    expect(screen.getAllByText('Thanks')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: tl.addEndingRule }));
    const rules = lastEdit().endingRules;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.endingId).toBe(second.id);
  });

  it('asks for a second ending before a rule can be added', () => {
    definition = withBlocks();
    search = { block: 'endings' };
    render(<LogicTab />);

    expect(screen.getByText(tl.needTwoEndings)).toBeTruthy();
    expect((screen.getByRole('button', { name: tl.addEndingRule }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists ending rules and edits them', () => {
    definition = withBlocks({
      endings: [base.endings[0]!, second],
      endingRules: [
        { id: 'r_1', when: { op: 'and', conditions: [{ left: { type: 'variable', name: 'score' }, operator: 'is_answered' }] }, endingId: second.id },
        { id: 'r_2', when: { op: 'and', conditions: [{ left: { type: 'variable', name: 'score' }, operator: 'is_answered' }] }, endingId: second.id },
      ],
    });
    search = { block: 'endings' };
    render(<LogicTab />);

    expect(screen.queryByText(tl.noEndingRules)).toBeNull();
    const downs = screen.getAllByRole('button', { name: tl.moveDown });
    fireEvent.click(downs[0]!);
    expect(lastEdit().endingRules.map((r) => r.id)).toEqual(['r_2', 'r_1']);
    const ups = screen.getAllByRole('button', { name: tl.moveUp });
    fireEvent.click(ups[1]!);
    expect(lastEdit().endingRules.map((r) => r.id)).toEqual(['r_2', 'r_1']);
    fireEvent.click(screen.getAllByRole('button', { name: en.common.actions.remove })[0]!);
    expect(lastEdit().endingRules.map((r) => r.id)).toEqual(['r_2']);
  });

  it('closes the panel with the close button, dropping only the block key', () => {
    search = { block: q1.id };
    render(<LogicTab />);

    fireEvent.click(screen.getByRole('button', { name: en.common.actions.close }));
    expect(navigatedSearch({ block: q1.id, other: 'keep' })).toEqual({ other: 'keep' });
  });

  it('opens a block when its card is clicked', () => {
    render(<LogicTab />);

    fireEvent.click(screen.getByText('2. Your email'));
    expect(navigatedSearch({ other: 'keep' })).toEqual({ other: 'keep', block: q2.id });
  });

  it('opens the ending rules when an ending card is clicked', () => {
    render(<LogicTab />);

    fireEvent.click(screen.getByText('Second ending'));
    expect(navigatedSearch({})).toEqual({ block: 'endings' });
  });

  it('shows no panel for an unknown block id', () => {
    search = { block: 'does_not_exist' };
    render(<LogicTab />);

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByText('1. Your name')).toBeTruthy();
  });

  it('shows the read-only notice and no add buttons when the member cannot edit', () => {
    canEdit = false;
    search = { block: q1.id };
    render(<LogicTab />);

    expect(screen.getByText(en.weldforms.editor.readOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: tl.addCalculation })).toBeNull();
    expect(screen.queryByRole('button', { name: tl.addJump })).toBeNull();
  });

  it('hides the ending rule button when read-only', () => {
    canEdit = false;
    search = { block: 'endings' };
    render(<LogicTab />);

    expect(screen.queryByRole('button', { name: tl.addEndingRule })).toBeNull();
  });
});
