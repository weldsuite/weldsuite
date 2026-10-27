import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});

import { AssistantMessage } from './chat-message';

describe('AssistantMessage', () => {
  it('renders a markdown table as a table, not as pipe text', () => {
    const content = [
      'There is 1 project.',
      '',
      '| # | Task | Assigned to |',
      '|---|---|---|',
      '| 1 | E2E task one | No one |',
      '| 2 | Mobile QA task | Maestro |',
    ].join('\n');
    const { container } = render(<AssistantMessage content={content} />);

    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['#', 'Task', 'Assigned to']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(container.textContent).not.toContain('|---|');
  });

  it('keeps a wide table inside a scroll box', () => {
    const { container } = render(<AssistantMessage content={'| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(container.querySelector('table')?.parentElement?.className).toContain('overflow-x-auto');
  });

  it('still renders lists and strikethrough', () => {
    const { container } = render(<AssistantMessage content={'- one\n- ~~two~~'} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('del')?.textContent).toBe('two');
  });
});
