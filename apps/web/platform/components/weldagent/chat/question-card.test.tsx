import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});

import { QuestionCard } from './question-card';

const question = {
  question: 'When should I act?',
  options: [
    { label: 'Every morning', description: 'At 08:00' },
    { label: 'On new tickets' },
  ],
};

const onAnswer = vi.fn();

beforeEach(() => onAnswer.mockReset());

describe('QuestionCard', () => {
  it('offers each option as a button that answers with one click', () => {
    render(<QuestionCard question={question} active onAnswer={onAnswer} />);
    const option = screen.getByRole('button', { name: /every morning/i });
    expect(option.tagName).toBe('BUTTON');
    fireEvent.click(option);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('Every morning');
  });

  it('keeps the options in the accessibility tree while a reply is on its way, without answering', () => {
    render(<QuestionCard question={question} active={false} onAnswer={onAnswer} />);
    const option = screen.getByRole('button', { name: /on new tickets/i });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(option);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('collects several options before answering a multi-select question', () => {
    render(<QuestionCard question={{ ...question, multiSelect: true }} active onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: /every morning/i }));
    fireEvent.click(screen.getByRole('button', { name: /on new tickets/i }));
    expect(screen.getByRole('button', { name: /every morning/i }).getAttribute('aria-pressed')).toBe('true');
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onAnswer).toHaveBeenCalledWith('Every morning, On new tickets');
  });

  it('shows the answer once it was given', () => {
    render(<QuestionCard question={question} active={false} answer="Every morning" onAnswer={onAnswer} />);
    expect(screen.getByText('Every morning')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /on new tickets/i })).toBeNull();
  });
});
