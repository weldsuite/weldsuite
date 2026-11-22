import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns], getLocale: () => 'en' };
});

import { encodeVisualMarker } from '@weldsuite/app-api-client/schemas/chat-visuals';
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

describe('AssistantMessage with visuals', () => {
  const table = {
    type: 'table' as const,
    title: 'Top deals',
    columns: [{ label: 'Deal' }, { label: 'Stage' }],
    rows: [
      ['Platform rollout', 'Negotiation'],
      ['Support renewal', 'Proposal'],
    ],
  };

  it('draws a visual where the reply showed it, between the text', { timeout: 20_000 }, async () => {
    const content = `Here are your deals.\n\n${encodeVisualMarker(table)}\n\nThe first is closest to closing.`;
    const { container } = render(<AssistantMessage content={content} />);
    expect(await screen.findByText('Top deals', {}, { timeout: 15_000 })).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text.indexOf('Here are your deals.')).toBeLessThan(text.indexOf('Top deals'));
    expect(text.indexOf('Top deals')).toBeLessThan(text.indexOf('The first is closest'));
    expect(text).not.toContain('\u001e');
  });

  it('holds the place of a visual still streaming in', () => {
    const content = `Drawing it now.\n\n${encodeVisualMarker(table).slice(0, 25)}`;
    const { container } = render(<AssistantMessage content={content} />);
    expect(screen.getByText('Drawing it now.')).toBeTruthy();
    expect(container.textContent).not.toContain('visual:');
  });
});
