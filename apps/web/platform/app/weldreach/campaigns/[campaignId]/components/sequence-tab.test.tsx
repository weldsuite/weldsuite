import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  campaignFixture,
  page,
  renderWithApp,
  stubRadixBrowserApis,
} from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({
  listProspects: vi.fn(),
  listEnrollments: vi.fn(),
  preview: vi.fn(),
  replaceSteps: vi.fn(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// React Flow needs a laid-out browser; this stand-in draws each canvas node as a
// button and the add control only when the tab passes `onAddStep`, as the canvas does.
vi.mock('@weldsuite/ui/components/workflow-canvas', () => ({
  WorkflowCanvas: ({
    steps,
    onSelectStep,
    onAddStep,
    labels,
  }: {
    steps: Array<{ id: string; name: string; summary?: string }>;
    onSelectStep: (index: number) => void;
    onAddStep?: (nodeId?: string) => void;
    labels?: { addStep?: string };
  }) => (
    <div data-testid="canvas">
      {steps.map((step, index) => (
        <button key={step.id} type="button" onClick={() => onSelectStep(index)}>
          {`node: ${step.name}${step.summary ? ` (${step.summary})` : ''}`}
        </button>
      ))}
      {onAddStep && (
        <button type="button" onClick={() => onAddStep(steps.at(-1)?.id)}>
          {labels?.addStep}
        </button>
      )}
    </div>
  ),
}));

import { SequenceTab } from './sequence-tab';

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  for (const fn of Object.values(reach)) fn.mockReset();
  reach.listProspects.mockResolvedValue(
    page([
      {
        id: 'prs_1',
        email: 'ana@acme.com',
        firstName: 'Ana',
        lastName: 'Jansen',
        companyName: 'Acme',
        companyDomain: 'acme.com',
        title: null,
        timezone: null,
        customFields: { industry: 'Software' },
        source: 'csv',
        sourceRef: null,
        personId: null,
        validation: 'valid',
        createdAt: '2026-10-01T09:00:00Z',
      },
    ]),
  );
  reach.listEnrollments.mockResolvedValue(page([]));
  reach.preview.mockResolvedValue({
    data: { subject: 'Quick question', body: 'Hi Ana', missingVariables: [] },
  });
});

describe('SequenceTab', () => {
  it('draws the steps on the canvas, opens the first one and keeps Save disabled until something changes', () => {
    renderWithApp(<SequenceTab campaign={campaignFixture()} canEdit />);

    expect(within(screen.getByTestId('canvas')).getByRole('button', { name: 'node: First email' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'First email' })).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Quick question');
    expect(screen.getByLabelText('Email')).toHaveValue('Hi {{firstName|there}}');
    expect(screen.getByRole('button', { name: 'Save sequence' })).toBeDisabled();
  });

  it('saves an added follow-up, with no delay on the first email', async () => {
    const user = userEvent.setup();
    const campaign = campaignFixture();
    reach.replaceSteps.mockImplementation(async (_id: string, steps: unknown[]) => ({
      data: { ...campaign, steps: steps.map((step, index) => ({ ...(step as object), id: `stp_${index}`, order: index })) },
    }));
    renderWithApp(<SequenceTab campaign={campaign} canEdit />);

    await user.click(screen.getByRole('button', { name: 'Add follow-up' }));
    // The new follow-up opens in the panel, and its wait shows on the canvas.
    expect(await screen.findByRole('heading', { name: 'Follow-up 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'node: Wait (3 days)' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Subject'), 'Following up');
    await user.type(screen.getByLabelText('Email'), 'Any thoughts?');
    await user.click(screen.getByRole('button', { name: 'Save sequence' }));

    await waitFor(() => expect(reach.replaceSteps).toHaveBeenCalledTimes(1));
    const [id, steps] = reach.replaceSteps.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(id).toBe('cmp_1');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ delayDays: 0, delayHours: 0, subject: 'Quick question' });
    expect(steps[1]).toMatchObject({
      delayDays: 3,
      subject: 'Following up',
      body: 'Any thoughts?',
      replyInThread: true,
    });
  });

  it('does not save a step without a subject and says what is wrong', async () => {
    const user = userEvent.setup();
    renderWithApp(<SequenceTab campaign={campaignFixture()} canEdit />);

    await user.clear(screen.getByLabelText('Subject'));
    await user.click(screen.getByRole('button', { name: 'Save sequence' }));

    expect(await screen.findByText('Enter a subject.')).toBeInTheDocument();
    expect(reach.replaceSteps).not.toHaveBeenCalled();
  });

  it('opens the step with an error when Save is refused for a step whose panel is closed', async () => {
    const user = userEvent.setup();
    const campaign = campaignFixture({
      steps: [
        ...campaignFixture().steps,
        { id: 'stp_2', order: 1, delayDays: 2, delayHours: 0, subject: 'Bump', body: 'Any news?', replyInThread: true },
      ],
    });
    renderWithApp(<SequenceTab campaign={campaign} canEdit />);

    await user.click(screen.getByRole('button', { name: 'node: Follow-up 1' }));
    await user.clear(screen.getByLabelText('Days'));
    await user.type(screen.getByLabelText('Days'), '120');
    await user.click(screen.getByRole('button', { name: 'node: First email' }));
    await user.click(screen.getByRole('button', { name: 'Save sequence' }));

    expect(await screen.findByRole('heading', { name: 'Follow-up 1' })).toBeInTheDocument();
    expect(screen.getByText('Enter 0 to 90 days and 0 to 23 hours.')).toBeInTheDocument();
    expect(reach.replaceSteps).not.toHaveBeenCalled();
  });

  it('shows the API message when saving is refused', async () => {
    const user = userEvent.setup();
    reach.replaceSteps.mockRejectedValue(new Error('Pause the campaign before changing its steps.'));
    renderWithApp(<SequenceTab campaign={campaignFixture()} canEdit />);

    await user.type(screen.getByLabelText('Subject'), '!');
    await user.click(screen.getByRole('button', { name: 'Save sequence' }));

    expect(await screen.findByText('Pause the campaign before changing its steps.')).toBeInTheDocument();
  });

  it('locks the editor while the campaign is active', () => {
    renderWithApp(<SequenceTab campaign={campaignFixture({ status: 'active' })} canEdit />);

    expect(screen.getByText('Pause the campaign to edit the sequence')).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add follow-up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove step' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save sequence' })).toBeDisabled();
  });

  it('opens the step clicked on the canvas, and shows a hint once the panel is closed', async () => {
    const user = userEvent.setup();
    const campaign = campaignFixture({
      steps: [
        ...campaignFixture().steps,
        { id: 'stp_2', order: 1, delayDays: 2, delayHours: 4, subject: 'Bump', body: 'Any news?', replyInThread: true },
      ],
    });
    renderWithApp(<SequenceTab campaign={campaign} canEdit />);

    await user.click(screen.getByRole('button', { name: 'node: Wait (2 days, 4 hours)' }));
    expect(screen.getByRole('heading', { name: 'Follow-up 1' })).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Bump');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Click an email on the canvas to edit it.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument();
  });

  it('removes a step from the panel and keeps a neighbour open', async () => {
    const user = userEvent.setup();
    const campaign = campaignFixture({
      steps: [
        ...campaignFixture().steps,
        { id: 'stp_2', order: 1, delayDays: 2, delayHours: 0, subject: 'Bump', body: 'Any news?', replyInThread: true },
      ],
    });
    renderWithApp(<SequenceTab campaign={campaign} canEdit />);

    await user.click(screen.getByRole('button', { name: 'node: Follow-up 1' }));
    await user.click(screen.getByRole('button', { name: 'Remove step' }));

    expect(screen.queryByRole('button', { name: 'node: Follow-up 1' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'First email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save sequence' })).toBeEnabled();
  });

  it('inserts a variable at the cursor', async () => {
    const user = userEvent.setup();
    renderWithApp(<SequenceTab campaign={campaignFixture()} canEdit />);

    const body = screen.getByLabelText('Email') as HTMLTextAreaElement;
    await user.click(body);
    body.setSelectionRange(0, 0);
    await user.click(screen.getByRole('button', { name: /Insert variable/ }));
    await user.click(await screen.findByRole('menuitem', { name: /\{\{companyName\}\}/ }));

    expect(body.value).toBe('{{companyName}}Hi {{firstName|there}}');
  });

  it('offers the custom fields seen on prospects as variables', async () => {
    const user = userEvent.setup();
    renderWithApp(<SequenceTab campaign={campaignFixture()} canEdit />);

    await waitFor(() => expect(reach.listProspects).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /Insert variable/ }));

    expect(await screen.findByRole('menuitem', { name: '{{industry}}' })).toBeInTheDocument();
  });

  it('warns about variables the preview could not fill', async () => {
    reach.preview.mockResolvedValue({
      data: { subject: 'Quick question', body: 'Hi {{title}}', missingVariables: ['title'] },
    });
    renderWithApp(<SequenceTab campaign={campaignFixture()} canEdit />);

    const warning = await screen.findByText(/These variables are empty for this prospect/, {}, { timeout: 3000 });
    expect(within(warning.closest('div') as HTMLElement).getByText(/\{\{title\}\}/)).toBeInTheDocument();
  });
});
