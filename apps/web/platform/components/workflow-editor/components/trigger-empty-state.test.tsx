import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldconnect: {
        triggerEmptyState: {
          title: 'Choose a trigger',
          subtitle: 'Select how this workflow should be started',
          entityEvent: 'Entity Event',
          entityEventDesc: 'Run when a record is created, updated, or deleted',
          integrationEvent: 'Integration Event',
          integrationEventDesc: 'Run when a connected app sends an event',
          schedule: 'Schedule',
          scheduleDesc: 'Run on a recurring or one-time schedule',
          workflowComplete: 'Workflow Complete',
          workflowCompleteDesc: 'Run when another workflow finishes',
          webhook: 'Webhook',
          webhookDesc: 'Run when an HTTP request is received',
          manual: 'Manual',
          manualDesc: 'Run only when triggered manually',
          api: 'API',
          apiDesc: 'Run when called via the WeldConnect API',
        },
      },
    },
  }),
}));

import { TriggerEmptyState } from './trigger-empty-state';

describe('TriggerEmptyState', () => {
  it('renders all trigger tiles with titles and descriptions', () => {
    render(<TriggerEmptyState onSelectType={() => {}} />);

    expect(screen.getByText('Choose a trigger')).toBeInTheDocument();
    expect(screen.getByText('Entity Event')).toBeInTheDocument();
    expect(screen.getByText('Run when a record is created, updated, or deleted')).toBeInTheDocument();
    expect(screen.getByText('Integration Event')).toBeInTheDocument();
    expect(screen.getByText('Workflow Complete')).toBeInTheDocument();
    expect(screen.getByText('API')).toBeInTheDocument();
  });

  it('overrides Button height/wrap defaults so card content is not crushed', () => {
    render(<TriggerEmptyState onSelectType={() => {}} />);

    const entityTile = screen.getByRole('button', { name: /Entity Event/i });
    expect(entityTile.className).toMatch(/\bh-auto\b/);
    expect(entityTile.className).toMatch(/\bwhitespace-normal\b/);
    expect(entityTile.className).toMatch(/\bw-full\b/);
    // Default Button size applies h-9; that must not remain after twMerge.
    expect(entityTile.className).not.toMatch(/\bh-9\b/);
    expect(entityTile.className).not.toMatch(/\bwhitespace-nowrap\b/);
  });

  it('calls onSelectType with the chosen trigger type', async () => {
    const onSelectType = vi.fn();
    const user = userEvent.setup();
    render(<TriggerEmptyState onSelectType={onSelectType} />);

    await user.click(screen.getByRole('button', { name: /Schedule/i }));
    expect(onSelectType).toHaveBeenCalledWith('schedule');
  });
});
