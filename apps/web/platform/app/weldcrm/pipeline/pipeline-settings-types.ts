/**
 * Pipeline view settings type
 */
export interface PipelineViewSettings {
  // View settings
  showAttributeLabels: boolean;
  visibleAttributes: {
    dealOwner: boolean;
    dealValue: boolean;
    nextDueTask: boolean;
    recordId: boolean;
    dealName: boolean;
    expectedCloseDate: boolean;
    probability: boolean;
    company: boolean;
    contact: boolean;
    tags: boolean;
  };
  groupBy: 'stage' | 'owner' | 'company' | 'none';
  // Pipeline settings
  autoAdvance: boolean;
  rottenDealDays: number;
  showProbability: boolean;
  showExpectedCloseDate: boolean;
  defaultCurrency: string;
  activityReminders: boolean;
  emailNotifications: boolean;
  slackIntegration: boolean;
  // Custom fields
  customFields: Array<{
    id: string;
    name: string;
    type: 'text' | 'number' | 'date' | 'select' | 'textarea';
    required: boolean;
    options?: string[];
  }>;
  // Per-stage UI state that used to live in local component state and reset
  // on every reload (TASK-921: "toggles and calculations aren't saved").
  // Keyed by stage id.
  stageCalculations: Record<string, { type: string; value: string | number }>;
  confettiStageIds: string[];
  trackTimeInStageIds: string[];
  // Stages hidden from the board. `crm_pipeline_stages` has no `hidden`
  // column, so this lives in the pipeline's own settings JSON instead.
  hiddenStageIds: string[];
}

export const DEFAULT_PIPELINE_SETTINGS: PipelineViewSettings = {
  showAttributeLabels: false,
  visibleAttributes: {
    dealOwner: true,
    dealValue: true,
    nextDueTask: true,
    recordId: false,
    dealName: true,
    expectedCloseDate: true,
    probability: true,
    company: true,
    contact: true,
    tags: true,
  },
  groupBy: 'stage',
  autoAdvance: true,
  rottenDealDays: 30,
  showProbability: true,
  showExpectedCloseDate: true,
  defaultCurrency: 'USD',
  activityReminders: true,
  emailNotifications: true,
  slackIntegration: false,
  customFields: [],
  stageCalculations: {},
  confettiStageIds: [],
  trackTimeInStageIds: [],
  hiddenStageIds: [],
};
