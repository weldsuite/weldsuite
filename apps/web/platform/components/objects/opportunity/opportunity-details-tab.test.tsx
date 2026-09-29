import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

vi.mock('@/components/team/member-select', () => ({
  MemberSelect: () => null,
}));

const stagesFixture = [
  { id: 'pls_stage3', name: 'Stage 3', position: 2, pipeline: 'pl_sales' },
  { id: 'pls_stage1', name: 'Stage 1', position: 0, pipeline: 'pl_sales' },
  { id: 'pls_stage2', name: 'Stage 2', position: 1, pipeline: 'pl_sales' },
];

const usePipelineStages = vi.fn();
vi.mock('@/hooks/queries/use-pipelines-queries', () => ({
  usePipelines: () => ({
    data: { data: [{ id: 'pl_sales', name: 'Sales pipeline' }] },
  }),
  usePipelineStages: (pipelineId?: string) => usePipelineStages(pipelineId),
}));

import { OpportunityDetailsTab } from './opportunity-panel';
import type { Opportunity } from './use-opportunity-data';

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'opp_1',
    name: 'Acme annual contract',
    customerId: 'cust_1',
    amount: '1000',
    stage: 'prospecting',
    stageId: 'pls_stage1',
    status: 'open',
    pipeline: 'pl_sales',
    ...overrides,
  } as Opportunity;
}

describe('OpportunityDetailsTab stage and pipeline rows', () => {
  beforeEach(() => {
    usePipelineStages.mockReset();
    usePipelineStages.mockReturnValue({ data: { data: stagesFixture } });
  });

  it('shows the stage and pipeline names instead of raw ids', () => {
    render(<OpportunityDetailsTab opportunity={makeOpportunity()} onUpdateField={vi.fn()} />);

    expect(screen.getByText('Stage 1')).toBeInTheDocument();
    expect(screen.getByText('Sales pipeline')).toBeInTheDocument();
    expect(screen.queryByText('pls_stage1')).not.toBeInTheDocument();
    expect(screen.queryByText('pl_sales')).not.toBeInTheDocument();
  });

  it("loads the stages of the deal's own pipeline", () => {
    render(<OpportunityDetailsTab opportunity={makeOpportunity()} onUpdateField={vi.fn()} />);
    expect(usePipelineStages).toHaveBeenCalledWith('pl_sales');
  });

  it("offers the pipeline's stages in order and moves the deal by stageId", async () => {
    const user = userEvent.setup();
    const onUpdateField = vi.fn();
    render(<OpportunityDetailsTab opportunity={makeOpportunity()} onUpdateField={onUpdateField} />);

    await user.click(screen.getByRole('button', { name: 'Stage 1' }));

    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Stage 1', 'Stage 2', 'Stage 3']);
    expect(screen.queryByText('Qualification')).not.toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: 'Stage 2' }));

    expect(onUpdateField).toHaveBeenCalledTimes(1);
    expect(onUpdateField).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: 'pls_stage2' }),
    );
    expect(onUpdateField.mock.calls[0][0]).not.toHaveProperty('pipeline');
  });

  it('labels a legacy deal without a stageId from its free-text stage', () => {
    render(
      <OpportunityDetailsTab
        opportunity={makeOpportunity({ stageId: undefined, stage: 'proposal' })}
        onUpdateField={vi.fn()}
      />,
    );
    expect(screen.getByText('sweep.entities.stageProposal')).toBeInTheDocument();
  });
});
