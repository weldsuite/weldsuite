import { describe, expect, it } from 'vitest';
import type { PipelineStage } from '@/hooks/queries/use-pipelines-queries';
import { pipelineBucket } from './weldcrm-pipeline';

function stage(id: string, name: string, position: number, extra: Partial<PipelineStage> = {}): PipelineStage {
  return { id, name, position, pipeline: 'pl_custom', createdAt: '', updatedAt: '', ...extra };
}

const stages: PipelineStage[] = [
  stage('pls_1', 'Intake', 0),
  stage('pls_2', 'Discovery', 1),
  stage('pls_3', 'Offer sent', 2),
  stage('pls_4', 'Negotiation', 3),
  stage('pls_won', 'Won', 4, { isWon: true }),
];

describe('pipelineBucket (TASK-1462)', () => {
  it('reads the stage through stageId, not the id held in `stage`', () => {
    // A custom pipeline's deal carries the stage id in `stage`.
    expect(pipelineBucket({ stage: 'pls_4', stageId: 'pls_4' }, stages)).toBe('negotiation');
  });

  it('places a stage whose name says nothing by its position among the open stages', () => {
    expect(pipelineBucket({ stage: 'pls_1', stageId: 'pls_1' }, stages)).toBe('lead');
    expect(pipelineBucket({ stage: 'pls_2', stageId: 'pls_2' }, stages)).toBe('qualified');
    expect(pipelineBucket({ stage: 'pls_3', stageId: 'pls_3' }, stages)).toBe('proposal');
  });

  it('falls back to the legacy stage name without a known stage', () => {
    expect(pipelineBucket({ stage: 'qualified', stageId: undefined }, stages)).toBe('qualified');
    expect(pipelineBucket({ stage: 'something', stageId: 'pls_gone' }, stages)).toBe('lead');
  });
});
