import { createBlankDefinition, createField, type FormDefinition } from '@weldsuite/forms-engine';

interface SampleText {
  welcome: string;
  nameQuestion: string;
  choiceQuestion: string;
  options: [string, string, string];
  ending: string;
}

/** A tiny form for theme previews: a welcome screen, a text question, a choice question and an ending. */
export function createSampleDefinition(text: SampleText): FormDefinition {
  const base = createBlankDefinition();
  const name = createField('short_text', { ref: 'name', title: text.nameQuestion });
  const choice = createField('multiple_choice', { ref: 'choice', title: text.choiceQuestion });
  choice.properties.choices = choice.properties.choices.map((c, i) => ({ ...c, label: text.options[i] ?? c.label }));
  return {
    ...base,
    welcome: { title: text.welcome },
    blocks: [{ ...name, required: true }, choice],
    endings: base.endings.map((e) => ({ ...e, title: text.ending })),
  };
}
